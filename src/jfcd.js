/**
 * jfcd.js — Japanese Flowchart Description Tool: core engine
 * Exposes window.JFCD = { compile, parse, layout, render }
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Shape keyword → internal type map                                    */
  /* ------------------------------------------------------------------ */
  const SHAPE_MAP = {
    '端子':         'terminal',
    '処理':         'process',
    '判断':         'decision',
    '入出力':       'io',
    '結合子':       'connector',
    'ページ外結合子': 'offpage_connector',
    'オフページコネクタ': 'offpage_connector',
    '定義済み処理': 'predefined',
    'レベルダウン記号': 'level_down',
    'レベルダウン': 'level_down',
    '手操作入力':   'manual_input',
    '手動入力':     'manual_input',
    '手動操作':     'manual_operation',
    '並行処理':     'parallel_mode',
    '書類':         'document',
    '注釈':         'annotation',
    '初期設定':     'preparation',
    '初期条件':     'preparation',
  };

  /* ------------------------------------------------------------------ */
  /* テキスト折り返しユーティリティ（Layout / Renderer 共用）            */
  /* ------------------------------------------------------------------ */
  /**
   * text を maxW (px) に収まるよう折り返した行配列を返す。
   * text 内の '\n' は強制改行として扱う。
   * fs: フォントサイズ (px)
   */
  function wrapLines(text, maxW, fs) {
    const cw = ch => ch.charCodeAt(0) > 0x7f ? fs : fs * 0.6;
    const result = [];
    for (const para of String(text || '').split('\n')) {
      let cur = '', curW = 0;
      for (const ch of para) {
        const w = cw(ch);
        if (curW + w > maxW && cur) { result.push(cur); cur = ''; curW = 0; }
        cur += ch; curW += w;
      }
      result.push(cur);
    }
    return result.length ? result : [''];
  }

  /** '\n' 区切りの段落のうち最も長い行の幅（px）を返す。折り返しは行わない。 */
  function textNaturalWidth(text, fs) {
    const cw = ch => ch.charCodeAt(0) > 0x7f ? fs : fs * 0.6;
    let max = 0;
    for (const para of String(text || '').split('\n')) {
      const w = [...para].reduce((s, ch) => s + cw(ch), 0);
      if (w > max) max = w;
    }
    return max;
  }

  /* ================================================================== */
  /* Parser                                                               */
  /* ================================================================== */
  class Parser {
    parse(input) {
      const ast = { title: 'フローチャート', nodes: [], edges: [], errors: [] };
      const nodeIds = new Set();

      const lines = input.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;

        /* フロー: タイトル */
        {
          const m = line.match(/^フロー[:：]\s*(.+)$/);
          if (m) { ast.title = m[1].trim(); continue; }
        }

        /* ノード定義: [id] 形状: ラベル  または  [id] ラベル */
        if (line.startsWith('[')) {
          const m = line.match(/^\[([^\]]+)\]\s*(.*)/);
          if (!m) {
            ast.errors.push({ line: lineNum, message: `不正なノード定義: "${line}"` });
            continue;
          }
          const id = m[1].trim();
          if (!id) {
            ast.errors.push({ line: lineNum, message: 'ノードIDが空です' });
            continue;
          }
          if (nodeIds.has(id)) {
            ast.errors.push({ line: lineNum, message: `ノードID「${id}」が重複しています` });
          }

          let shape = 'process';
          let label = m[2].trim() || id;

          for (const [kw, type] of Object.entries(SHAPE_MAP)) {
            const km = m[2].trim().match(new RegExp(`^${kw}[:：]\\s*(.*)`));
            if (km) { shape = type; label = km[1].trim() || id; break; }
          }

          /* ラベル内の "\n" リテラルを実際の改行に変換（複数行注釈等に使用） */
          label = label.replace(/\\n/g, '\n');

          ast.nodes.push({ id, shape, label });
          nodeIds.add(id);
          continue;
        }

        /* 接続定義: from --> to  または  from --> to : ラベル */
        if (line.includes('-->')) {
          const m = line.match(/^(.+?)\s*-->\s*([^:：\n]+?)(?:\s*[:：]\s*(.*))?$/);
          if (!m) {
            ast.errors.push({ line: lineNum, message: `不正な接続定義: "${line}"` });
            continue;
          }
          {
            const rawLabel  = (m[3] || '').trim();
            const hintMatch = rawLabel.match(/\s*@(right|left|down)$/i);
            const exitHint  = hintMatch ? hintMatch[1].toLowerCase() : null;
            const label     = hintMatch ? rawLabel.slice(0, hintMatch.index).trimEnd() : rawLabel;
            ast.edges.push({ from: m[1].trim(), to: m[2].trim(), label, exitHint });
          }
          continue;
        }

        ast.errors.push({ line: lineNum, message: `解析できない行: "${line}"` });
      }

      /* 参照チェック */
      for (const e of ast.edges) {
        if (!nodeIds.has(e.from))
          ast.errors.push({ message: `未定義のノード「${e.from}」が接続元として使われています` });
        if (!nodeIds.has(e.to))
          ast.errors.push({ message: `未定義のノード「${e.to}」が接続先として使われています` });
      }

      return ast;
    }
  }

  /* ================================================================== */
  /* Layout                                                               */
  /* ================================================================== */
  class Layout {
    constructor() {
      /* ノードの基本寸法 (px) */
      this.DIMS = {
        terminal:     { w: 130, h: 44 },
        process:      { w: 150, h: 50 },
        decision:     { w: 160, h: 84 },
        io:           { w: 150, h: 50 },
        connector:    { w: 50,  h: 50 },
        offpage_connector: { w: 110, h: 64 },
        predefined:   { w: 150, h: 50 },
        level_down:   { w: 150, h: 50 },
        manual_input: { w: 150, h: 50 },
        manual_operation: { w: 150, h: 50 },
        parallel_mode: { w: 160, h: 54 },
        document:     { w: 150, h: 58 },
        annotation:   { w: 160, h: 50 },
        preparation:  { w: 160, h: 50 },
      };
      this.HGAP     = 60;   /* 同レイヤー内の水平余白          */
      this.VGAP     = 60;   /* レイヤー間の垂直余白            */
      this.PAD      = 70;   /* 図全体の外側余白                */
      this.ANNO_GAP = 80;   /* コンテンツ端 ↔ 注釈端の余白（左右共通; Renderer のループバック右側オフセット 40px と干渉しない幅） */
      this.BRANCH_SIDE_EXTRA_GAP = 40; /* 条件分岐の右側枝を外側へ寄せる追加余白（注釈余白とは独立） */
    }

    dim(shape) { return this.DIMS[shape] || this.DIMS.process; }

    compute(ast) {
      /* 注釈ノードをメインフローから分離 */
      const annoIds   = new Set(ast.nodes.filter(n => n.shape === 'annotation').map(n => n.id));
      const nodes     = ast.nodes.filter(n => !annoIds.has(n.id));
      const edges     = ast.edges.filter(e => !annoIds.has(e.from) && !annoIds.has(e.to));
      const allEdges  = ast.edges;   /* 注釈接続エッジの解決に使用 */

      if (!nodes.length) return { positions: {}, width: 300, height: 150 };

      const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));

      /* 隣接リスト構築 */
      const succ = Object.fromEntries(nodes.map(n => [n.id, []]));
      for (const e of edges) {
        if (succ[e.from] !== undefined && succ[e.to] !== undefined) {
          succ[e.from].push(e.to);
        }
      }

      /* DFS によるバックエッジ検出（サイクルを前向きグラフから除外するため） */
      const backEdgeSet = new Set();
      {
        const visited = new Set();
        const inStack = new Set();
        const dfs = (id) => {
          visited.add(id);
          inStack.add(id);
          for (const next of succ[id]) {
            if (!visited.has(next)) {
              dfs(next);
            } else if (inStack.has(next)) {
              backEdgeSet.add(`${id}\0${next}`);
            }
          }
          inStack.delete(id);
        };
        for (const n of nodes) {
          if (!visited.has(n.id)) dfs(n.id);
        }
      }

      /* バックエッジを除いた前向きグラフの入次数を算出しルートノードを特定 */
      const fwdPred = Object.fromEntries(nodes.map(n => [n.id, []]));
      for (const e of edges) {
        if (succ[e.from] !== undefined && fwdPred[e.to] !== undefined &&
            !backEdgeSet.has(`${e.from}\0${e.to}`)) {
          fwdPred[e.to].push(e.from);
        }
      }

      /* BFS によるレイヤー割り当て (最長パス, バックエッジ除外) */
      const layer = {};
      const roots = nodes.filter(n => fwdPred[n.id].length === 0);
      if (!roots.length) roots.push(nodes[0]);

      const queue = roots.map(r => r.id);
      for (const id of queue) if (layer[id] === undefined) layer[id] = 0;

      let qi = 0;
      while (qi < queue.length) {
        const id = queue[qi++];
        for (const next of succ[id]) {
          if (backEdgeSet.has(`${id}\0${next}`)) continue; /* バックエッジをスキップ */
          const nl = layer[id] + 1;
          if (layer[next] === undefined || layer[next] < nl) {
            layer[next] = nl;
            queue.push(next);
          }
        }
      }
      for (const n of nodes) if (layer[n.id] === undefined) layer[n.id] = 0;

      /*
       * ループ出口レイヤー補正
       * バックエッジ (src → tgt) ごとに、ループ本体内のノードから
       * 本体外へ出る「出口ノード」を layer[src]+1 以上に引き上げる。
       * これにより、判断ノードを挟むループ出口もループ本体の後ろへ縦に続く。
       */
      const sortedBackEdges = [...backEdgeSet].sort((a, b) => {
        const aSrc = a.slice(0, a.indexOf('\0'));
        const bSrc = b.slice(0, b.indexOf('\0'));
        return (layer[aSrc] || 0) - (layer[bSrc] || 0);
      });

      for (const beKey of sortedBackEdges) {
        const sep = beKey.indexOf('\0');
        const beSrc = beKey.slice(0, sep);
        const beTgt = beKey.slice(sep + 1);

        /* tgt からの前向き到達可能集合 */
        const fwdReach = new Set([beTgt]);
        const fwdQ = [beTgt];
        for (let fi = 0; fi < fwdQ.length; fi++) {
          for (const nx of succ[fwdQ[fi]]) {
            if (!backEdgeSet.has(`${fwdQ[fi]}\0${nx}`) && !fwdReach.has(nx)) {
              fwdReach.add(nx); fwdQ.push(nx);
            }
          }
        }

        /* beSrc に到達できるノード集合（前向きエッジのみ、不動点反復）*/
        const canReachSrc = new Set([beSrc]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const n of nodes) {
            if (canReachSrc.has(n.id)) continue;
            for (const nx of succ[n.id]) {
              if (!backEdgeSet.has(`${n.id}\0${nx}`) && canReachSrc.has(nx)) {
                canReachSrc.add(n.id); changed = true; break;
              }
            }
          }
        }

        /* ループ本体 = fwdReach ∩ canReachSrc */
        const loopBody = new Set([...fwdReach].filter(id => canReachSrc.has(id)));

        /* ループ本体から外へ出る出口後継を layer[beSrc]+1 以上に引き上げ、前向きに伝播 */
        const minExit = layer[beSrc] + 1;
        const upQ = [];
        for (const bodyId of loopBody) {
          for (const nx of succ[bodyId]) {
            if (!backEdgeSet.has(`${bodyId}\0${nx}`) && !loopBody.has(nx) && layer[nx] < minExit) {
              layer[nx] = minExit; upQ.push(nx);
            }
          }
        }
        for (let ui = 0; ui < upQ.length; ui++) {
          for (const nx of succ[upQ[ui]]) {
            if (!backEdgeSet.has(`${upQ[ui]}\0${nx}`)) {
              const nl = layer[upQ[ui]] + 1;
              if (layer[nx] < nl) { layer[nx] = nl; upQ.push(nx); }
            }
          }
        }
      }

      /* レイヤーごとにグループ化 */
      const groups = {};
      for (const n of nodes) {
        const l = layer[n.id];
        (groups[l] = groups[l] || []).push(n.id);
      }
      const layerNums = Object.keys(groups).map(Number).sort((a, b) => a - b);

      /* 各レイヤーの行幅を計算し、最大幅を求める */
      const rowWidths = layerNums.map(l =>
        groups[l].reduce((s, id) => s + this.dim(nodeMap[id].shape).w, 0)
        + this.HGAP * (groups[l].length - 1)
      );
      const maxRowW = Math.max(...rowWidths, 0);
      const totalW  = maxRowW + 2 * this.PAD;

      /* 各ノードの座標を決定 */
      const positions = {};
      let y = this.PAD;

      for (let li = 0; li < layerNums.length; li++) {
        const l      = layerNums[li];
        const group  = groups[l];
        const rowH   = Math.max(...group.map(id => this.dim(nodeMap[id].shape).h));
        const rw     = rowWidths[li];
        let   x      = (totalW - rw) / 2;

        for (const id of group) {
          const d = this.dim(nodeMap[id].shape);
          positions[id] = { x: x + d.w / 2, y: y + rowH / 2, w: d.w, h: d.h };
          x += d.w + this.HGAP;
        }
        y += rowH + this.VGAP;
      }

      /* 条件分岐: 主系統（下側）を縦一直線に揃え、右側枝を外側へ寄せる */
      this._alignDecisionBranches(nodes, edges, positions, groups, layer, nodeMap);

      const mainHeight = y - this.VGAP + this.PAD;

      /* 注釈ノードを右側に配置し、最終幅を算出 */
      const finalWidth = this._placeAnnotations(ast, annoIds, positions, totalW);

      return { positions, width: finalWidth, height: mainHeight };
    }

    /**
     * 注釈ノードをメイン図の左右に配置し positions を更新する。
     * 基本は右側配置。主列（メイン図で最もノード数が多い縦列）の両側に
     * ソースノードがある場合のみ左右に自動分配し、@left/@right で明示上書きできる。
     * 戻り値: 注釈列を含む最終的な SVG 幅
     */
    _placeAnnotations(ast, annoIds, positions, mainTotalW) {
      if (!annoIds.size) return mainTotalW;

      const mainNodes = ast.nodes.filter(n => !annoIds.has(n.id));

      /* コンテンツ左右端を返すヘルパー（positions 更新後に再計算するため関数化） */
      const getContentRight = () => mainNodes.length > 0
        ? Math.max(...mainNodes.map(n => { const p = positions[n.id]; return p ? p.x + p.w / 2 : 0; }))
        : mainTotalW - this.PAD;
      const getContentLeft = () => mainNodes.length > 0
        ? Math.min(...mainNodes.map(n => { const p = positions[n.id]; return p ? p.x - p.w / 2 : Infinity; }))
        : this.PAD;

      const initContentLeft  = getContentLeft();
      const initContentRight = getContentRight();
      const mainCenterX = (initContentLeft + initContentRight) / 2;
      const mainNodeXs = mainNodes
        .map(n => positions[n.id] ? positions[n.id].x : null)
        .filter(x => typeof x === 'number');
      const mainColumnCounts = new Map();
      for (const x of mainNodeXs) {
        const key = x.toFixed(1);
        const entry = mainColumnCounts.get(key);
        if (entry) entry.count += 1;
        else mainColumnCounts.set(key, { x, count: 1 });
      }
      const maxMainColumnCount = mainColumnCounts.size
        ? Math.max(...[...mainColumnCounts.values()].map(v => v.count))
        : 0;
      const dominantMainColumns = [...mainColumnCounts.values()].filter(v => v.count === maxMainColumnCount);
      const mainColumnX = dominantMainColumns.length === 1 ? dominantMainColumns[0].x : mainCenterX;

      const annoMinW = this.DIMS.annotation.w;
      const annoFS   = 13;
      const annoLH   = annoFS * 1.45;
      const annoPadV = 8;
      /* ブラケット腕 (bw=7) + 左内側余白 (4) + 右余白 (9) = 20px */
      const ANNO_INNER_PAD = 20;
      /* 注釈接続元の水平広がりがノード間ギャップ以上で、かつ主列（最もノード数が多い縦列）の両側にソースノードがある場合のみ自動分配 */
      const ANNO_HORIZ_SPLIT_THRESHOLD = this.HGAP;

      /* ── 第1パス: 各注釈の寸法・配置サイドを決定 ── */
      const annoPlan = [];
      const annoSources = ast.nodes
        .filter(n => annoIds.has(n.id))
        .map(anno => {
          const srcEdge = ast.edges.find(e => e.to === anno.id && !annoIds.has(e.from));
          if (!srcEdge || !positions[srcEdge.from]) return null;
          return { annoId: anno.id, srcId: srcEdge.from, x: positions[srcEdge.from].x, y: positions[srcEdge.from].y };
        })
        .filter(v => !!v);
      const annoSourceXs = annoSources.map(v => v.x);
      const spreadX = annoSourceXs.length > 1 ? Math.max(...annoSourceXs) - Math.min(...annoSourceXs) : 0;
      const hasLeftSrcNode  = annoSourceXs.some(x => x < mainColumnX);
      const hasRightSrcNode = annoSourceXs.some(x => x > mainColumnX);
      const autoSplitByHorizontal = spreadX >= ANNO_HORIZ_SPLIT_THRESHOLD && hasLeftSrcNode && hasRightSrcNode;
      const localSplitSideBySrcId = new Map();
      const sourceById = new Map();
      for (const s of annoSources) {
        if (!sourceById.has(s.srcId)) sourceById.set(s.srcId, { srcId: s.srcId, x: s.x, y: s.y });
      }
      const sourceRows = new Map();
      for (const s of sourceById.values()) {
        const key = s.y.toFixed(1);
        if (!sourceRows.has(key)) sourceRows.set(key, []);
        sourceRows.get(key).push(s);
      }
      for (const row of sourceRows.values()) {
        if (row.length < 2) continue;
        const minX = Math.min(...row.map(v => v.x));
        const maxX = Math.max(...row.map(v => v.x));
        if (maxX - minX < ANNO_HORIZ_SPLIT_THRESHOLD) continue;
        const rowCenterX = (minX + maxX) / 2;
        for (const s of row) {
          localSplitSideBySrcId.set(s.srcId, s.x < rowCenterX ? 'left' : 'right');
        }
      }
      for (const anno of ast.nodes.filter(n => annoIds.has(n.id))) {
        const srcEdge = ast.edges.find(e => e.to === anno.id && !annoIds.has(e.from));
        if (!srcEdge || !positions[srcEdge.from]) continue;

        const naturalW = textNaturalWidth(anno.label, annoFS);
        const w = Math.max(annoMinW, naturalW + ANNO_INNER_PAD);
        const lines = anno.label ? String(anno.label).split('\n') : [''];
        const h = Math.max(28, lines.length * annoLH + annoPadV * 2);

        /* 基本は右側。明示指定を優先し、同一段の横並びがあれば段内基準、それ以外は主列基準で自動分配する。 */
        const side = srcEdge.exitHint === 'left'
          ? 'left'
          : srcEdge.exitHint === 'right'
            ? 'right'
            : localSplitSideBySrcId.has(srcEdge.from)
              ? localSplitSideBySrcId.get(srcEdge.from)
            : autoSplitByHorizontal
              ? (positions[srcEdge.from].x < mainColumnX ? 'left' : 'right')
              : 'right';
        annoPlan.push({ anno, srcId: srcEdge.from, w, h, side });
      }

      /* ── 左側注釈のために必要な余白を計算し、全メインノードを右へシフト ── */
      let leftExtension = 0;
      for (const { w, side } of annoPlan) {
        if (side === 'left') {
          const annoLeft = initContentLeft - this.ANNO_GAP - w;
          if (annoLeft < this.PAD) {
            leftExtension = Math.max(leftExtension, this.PAD - annoLeft);
          }
        }
      }
      if (leftExtension > 0) {
        for (const n of mainNodes) {
          if (positions[n.id]) positions[n.id].x += leftExtension;
        }
      }

      /* シフト後のコンテンツ境界を再取得 */
      const contentRight = getContentRight();
      const contentLeft  = getContentLeft();

      /* ── 第2パス: 注釈を配置 ── */
      let maxRight = mainTotalW + leftExtension;
      for (const { anno, srcId, w, h, side } of annoPlan) {
        const srcPos = positions[srcId]; /* シフト済み */
        const annoX  = side === 'right'
          ? contentRight + this.ANNO_GAP + w / 2
          : contentLeft  - this.ANNO_GAP - w / 2;

        positions[anno.id] = { x: annoX, y: srcPos.y, w, h, annoSide: side };

        if (side === 'right') {
          maxRight = Math.max(maxRight, annoX + w / 2 + this.PAD);
        }
      }

      /* ── 注釈同士の縦重なりを解消（左右それぞれ独立して処理） ── */
      const ANNO_VGAP = 10;   /* 注釈間の最低垂直余白 */
      for (const side of ['left', 'right']) {
        const placed = ast.nodes
          .filter(n => annoIds.has(n.id) && positions[n.id] && positions[n.id].annoSide === side)
          .map(n => positions[n.id])
          .sort((a, b) => a.y - b.y);
        for (let i = 1; i < placed.length; i++) {
          const prev = placed[i - 1];
          const cur  = placed[i];
          const minY = prev.y + prev.h / 2 + ANNO_VGAP + cur.h / 2;
          if (cur.y < minY) cur.y = minY;
        }
      }

      return maxRight;
    }

    /**
     * 条件分岐の枝を調整する。
     * - 主系統（下方向）は判断ノード中心 x に揃える
     * - 右側枝は十分右へ寄せる
     * - 同レイヤー内の水平重なりを右方向シフトで解消する
     */
    _alignDecisionBranches(nodes, edges, positions, groups, layer, nodeMap) {
      const outMap = Object.fromEntries(nodes.map(n => [n.id, []]));
      for (const e of edges) {
        if (outMap[e.from] && positions[e.to]) outMap[e.from].push(e);
      }

      const YES_RE = /^(はい|yes|Yes|TRUE|true|Y|y)$/;

      for (const n of nodes) {
        if (n.shape !== 'decision' || !positions[n.id]) continue;
        const out = (outMap[n.id] || []).filter(e => positions[e.to]);
        if (out.length < 2) continue;

        const ys = out.map(e => positions[e.to].y);
        const minY = Math.min(...ys);
        const allSameY = ys.every(y => y === minY);
        const yesEdge = out.find(e => YES_RE.test(String(e.label || '')));

        let downEdge = null;
        if (out.some(e => e.exitHint === 'down')) {
          downEdge = out.find(e => e.exitHint === 'down');
        } else if (!allSameY) {
          downEdge = out.find(e => positions[e.to].y === minY) || out[0];
        } else {
          downEdge = yesEdge || out[0];
        }
        if (!downEdge || !positions[downEdge.to]) continue;

        const decPos = positions[n.id];
        const downPos = positions[downEdge.to];
        downPos.x = decPos.x;

        const sameLayerSides = out.filter(e => e.to !== downEdge.to && layer[e.to] === layer[downEdge.to]);
        for (const sideEdge of sameLayerSides) {
          const sidePos = positions[sideEdge.to];
          if (!sidePos) continue;
          const minSideX = downPos.x + downPos.w / 2 + this.HGAP + this.BRANCH_SIDE_EXTRA_GAP + sidePos.w / 2;
          if (sidePos.x < minSideX) {
            const delta = minSideX - sidePos.x;
            this._shiftLayerRight(groups[layer[sideEdge.to]] || [], positions, sidePos.x, delta);
          }
        }
      }

      /* 同レイヤー内のノード重なりを左から右へ解消 */
      for (const layerId of Object.keys(groups)) {
        const ids = (groups[layerId] || [])
          .filter(id => positions[id])
          .sort((a, b) => positions[a].x - positions[b].x);
        for (let i = 1; i < ids.length; i++) {
          const prev = positions[ids[i - 1]];
          const cur  = positions[ids[i]];
          const minX = prev.x + prev.w / 2 + this.HGAP + cur.w / 2;
          if (cur.x < minX) {
            this._shiftLayerRight(ids.slice(i), positions, cur.x, minX - cur.x);
          }
        }
      }
    }

    _shiftLayerRight(ids, positions, thresholdX, delta) {
      if (delta <= 0) return;
      for (const id of ids) {
        const p = positions[id];
        if (p && p.x >= thresholdX - 0.1) p.x += delta;
      }
    }
  }

  /* ================================================================== */
  /* Renderer                                                             */
  /* ================================================================== */
  class Renderer {
    constructor() {
      this.FONT = "Meiryo, 'Yu Gothic', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif";
      this.FS   = 13;          /* font-size (px) */
      this.SW   = 1.8;         /* stroke-width   */
      this.SC   = '#1a1a1a';   /* stroke color   */
      this.FC   = '#ffffff';   /* fill color     */
      this.LOOPBACK_RIGHT_OFFSET = 40;
      this.LOOPBACK_DOWN_OFFSET  = 24;
    }

    render(ast, layoutResult) {
      const { nodes, edges } = ast;
      const { positions, width, height } = layoutResult;

      /* _edge() で y 座標比較に使用するため positions を保持 */
      this._positions = positions;
      this._rightBypassX = Math.max(
        ...Object.values(positions).map(p => p.x + p.w / 2),
        width - 2 * this.LOOPBACK_RIGHT_OFFSET
      ) + this.LOOPBACK_RIGHT_OFFSET;

      /* 注釈ノードの ID セット */
      const annoIds = new Set(nodes.filter(n => n.shape === 'annotation').map(n => n.id));

      /* 判断ノードの出力エッジリスト（注釈エッジを除外） */
      const decisionEdgeMap = {};
      for (const n of nodes) {
        if (n.shape === 'decision') {
          decisionEdgeMap[n.id] = edges.filter(e => e.from === n.id && !annoIds.has(e.to));
        }
      }
      /* 合流判定用: 注釈エッジを除いた to ノードごとの流入本数（2本以上で合流） */
      const incomingEdgeCount = {};
      for (const e of edges) {
        if (annoIds.has(e.to)) continue;
        incomingEdgeCount[e.to] = (incomingEdgeCount[e.to] || 0) + 1;
      }

      let body = '';

      /* エッジを先に描画（ノードの下に重なる） */
      for (const edge of edges) {
        const fp = positions[edge.from];
        const tp = positions[edge.to];
        if (!fp || !tp) continue;

        /* 注釈へのエッジは破線コネクタとして別描画 */
        if (annoIds.has(edge.to)) {
          body += this._annotationEdge(fp, tp);
          continue;
        }

        const fn = nodes.find(n => n.id === edge.from);
        const tn = nodes.find(n => n.id === edge.to);
        const targetIsMergePoint = (incomingEdgeCount[edge.to] || 0) >= 2;
        body += this._edge(
          edge,
          fp,
          tp,
          fn,
          tn,
          decisionEdgeMap[fn.id] || null,
          targetIsMergePoint
        );
      }

      /* ノードを後に描画 */
      for (const node of nodes) {
        const p = positions[node.id];
        if (!p) continue;
        body += this._node(node, p);
      }

      const W = Math.max(width,  300);
      const H = Math.max(height, 200);
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n` +
        `  <defs>\n` +
        `    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">\n` +
        `      <path d="M0,0 L0,6 L8,3 z" fill="${this.SC}"/>\n` +
        `    </marker>\n` +
        `  </defs>\n` +
        `  <rect width="${W}" height="${H}" fill="#f7f8fa"/>\n` +
        `  ${body}\n` +
        `</svg>`
      );
    }

    /* ── ノード種別ごとの描画 ─────────────────────────── */
    _node(n, p) {
      switch (n.shape) {
        case 'terminal':     return this._terminal(n, p);
        case 'decision':     return this._decision(n, p);
        case 'io':           return this._io(n, p);
        case 'connector':    return this._connector(n, p);
        case 'offpage_connector': return this._offpageConnector(n, p);
        case 'predefined':   return this._predefined(n, p);
        case 'level_down':   return this._levelDown(n, p);
        case 'manual_input': return this._manualInput(n, p);
        case 'manual_operation': return this._manualOperation(n, p);
        case 'parallel_mode': return this._parallelMode(n, p);
        case 'document':     return this._document(n, p);
        case 'annotation':   return this._annotation(n, p);
        case 'preparation':  return this._preparation(n, p);
        default:             return this._process(n, p);
      }
    }

    /** 端子 — 角丸長方形（スタジアム形） */
    _terminal(n, p) {
      const r = p.h / 2;
      return `<g>` +
        `<rect x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" rx="${r}" ry="${r}" fill="${this.FC}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, p.y, p.w - r) +
        `</g>`;
    }

    /** 処理 — 長方形 */
    _process(n, p) {
      return `<g>` +
        `<rect x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" fill="${this.FC}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, p.y, p.w - 12) +
        `</g>`;
    }

    /** 判断 — ひし形 */
    _decision(n, p) {
      const pts = `${p.x},${p.y - p.h / 2} ${p.x + p.w / 2},${p.y} ${p.x},${p.y + p.h / 2} ${p.x - p.w / 2},${p.y}`;
      return `<g>` +
        `<polygon points="${pts}" fill="${this.FC}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, p.y, p.w - 32) +
        `</g>`;
    }

    /** 入出力 — 平行四辺形 */
    _io(n, p) {
      const off = 14;
      const pts = `${p.x - p.w / 2 + off},${p.y - p.h / 2} ${p.x + p.w / 2},${p.y - p.h / 2} ${p.x + p.w / 2 - off},${p.y + p.h / 2} ${p.x - p.w / 2},${p.y + p.h / 2}`;
      return `<g>` +
        `<polygon points="${pts}" fill="${this.FC}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, p.y, p.w - off * 2 - 4) +
        `</g>`;
    }

    /** 結合子 — 円 */
    _connector(n, p) {
      return `<g>` +
        `<circle cx="${p.x}" cy="${p.y}" r="${p.w / 2}" fill="${this.FC}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, p.y, p.w - 8) +
        `</g>`;
    }

    /** オフページコネクタ（ページ外結合子）— 家型五角形 */
    _offpageConnector(n, p) {
      const roofY = p.y - p.h / 6;
      const pts = `${p.x},${p.y - p.h / 2} ` +
                  `${p.x + p.w / 2},${roofY} ` +
                  `${p.x + p.w / 2},${p.y + p.h / 2} ` +
                  `${p.x - p.w / 2},${p.y + p.h / 2} ` +
                  `${p.x - p.w / 2},${roofY}`;
      return `<g>` +
        `<polygon points="${pts}" fill="${this.FC}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, p.y + p.h * 0.1, p.w - 12) +
        `</g>`;
    }

    /** 定義済み処理 — 両端二重縦線付き長方形 */
    _predefined(n, p) {
      const io = 10;
      const x0 = p.x - p.w / 2, y0 = p.y - p.h / 2;
      const x1 = p.x + p.w / 2, y1 = p.y + p.h / 2;
      return `<g>` +
        `<rect x="${x0}" y="${y0}" width="${p.w}" height="${p.h}" fill="${this.FC}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        `<line x1="${x0 + io}" y1="${y0}" x2="${x0 + io}" y2="${y1}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        `<line x1="${x1 - io}" y1="${y0}" x2="${x1 - io}" y2="${y1}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, p.y, p.w - io * 2 - 12) +
        `</g>`;
    }

    /** レベルダウン記号 — 内部水平線付き長方形 */
    _levelDown(n, p) {
      const x0 = p.x - p.w / 2, y0 = p.y - p.h / 2;
      const ySep = y0 + p.h * 0.52;
      return `<g>` +
        `<rect x="${x0}" y="${y0}" width="${p.w}" height="${p.h}" fill="${this.FC}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        `<line x1="${x0}" y1="${ySep}" x2="${x0 + p.w}" y2="${ySep}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, y0 + (ySep - y0) / 2, p.w - 16) +
        `</g>`;
    }

    /** 手操作入力 — 上辺が斜めの台形 */
    _manualInput(n, p) {
      const slope = 10;
      const pts = `${p.x - p.w / 2},${p.y - p.h / 2} ${p.x + p.w / 2},${p.y - p.h / 2 + slope} ${p.x + p.w / 2},${p.y + p.h / 2} ${p.x - p.w / 2},${p.y + p.h / 2}`;
      return `<g>` +
        `<polygon points="${pts}" fill="${this.FC}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, p.y + slope / 2, p.w - 12) +
        `</g>`;
    }

    /** 手動操作 — 逆台形（上辺が長く、下辺が短い） */
    _manualOperation(n, p) {
      const inset = 14;
      const pts = `${p.x - p.w / 2},${p.y - p.h / 2} ${p.x + p.w / 2},${p.y - p.h / 2} ${p.x + p.w / 2 - inset},${p.y + p.h / 2} ${p.x - p.w / 2 + inset},${p.y + p.h / 2}`;
      return `<g>` +
        `<polygon points="${pts}" fill="${this.FC}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, p.y, p.w - inset * 2 - 4) +
        `</g>`;
    }

    /** 並行処理 — 2本の平行横線 */
    _parallelMode(n, p) {
      const x0 = p.x - p.w / 2;
      const x1 = p.x + p.w / 2;
      const y0 = p.y - p.h / 2;
      const y1 = p.y + p.h / 2;
      return `<g>` +
        `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, p.y, p.w - 8) +
        `</g>`;
    }

    /** 書類 — 下端が波形の長方形 */
    _document(n, p) {
      const wh = 8;
      const x0 = p.x - p.w / 2, y0 = p.y - p.h / 2;
      const x1 = p.x + p.w / 2, y1 = p.y + p.h / 2;
      const d  = `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1 - wh}` +
                 ` Q ${p.x + p.w / 4} ${y1} ${p.x} ${y1 - wh}` +
                 ` Q ${p.x - p.w / 4} ${y1 - wh * 2} ${x0} ${y1 - wh} Z`;
      return `<g>` +
        `<path d="${d}" fill="${this.FC}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, p.y - wh / 2, p.w - 12) +
        `</g>`;
    }

    /**
     * 注釈 — ブラケットスタイル
     * 右側注釈 (annoSide !== 'left'): 左ブラケット「[」— 左辺縦線＋上下短い横線
     * 左側注釈 (annoSide === 'left'): 右ブラケット「]」— 右辺縦線＋上下短い横線
     */
    _annotation(n, p) {
      const x0 = p.x - p.w / 2;
      const x1 = p.x + p.w / 2;
      const y0 = p.y - p.h / 2;
      const y1 = p.y + p.h / 2;
      const bw = 7;   /* ブラケット横腕の長さ */

      if (p.annoSide === 'left') {
        /* 右ブラケット「]」スタイル: ブラケットは右辺、テキストは左揃えで内側 */
        const bracket = `M${x1 - bw},${y0} L${x1},${y0} L${x1},${y1} L${x1 - bw},${y1}`;
        return `<g>` +
          `<path d="${bracket}" fill="none" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
          this._lblLeft(n.label, x0 + 4, p.y, p.w - bw - 8) +
          `</g>`;
      }

      /* 左ブラケット「[」スタイル（デフォルト: 右側注釈） */
      const bracket = `M${x0 + bw},${y0} L${x0},${y0} L${x0},${y1} L${x0 + bw},${y1}`;
      return `<g>` +
        `<path d="${bracket}" fill="none" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lblLeft(n.label, x0 + bw + 4, p.y, p.w - bw - 8) +
        `</g>`;
    }

    /** 初期設定／初期条件 — 両端三角形の六角形（準備記号） */
    _preparation(n, p) {
      const tip = p.h / 2;   /* 左右の突起量（45度の角） */
      const pts = `${p.x - p.w / 2},${p.y} ` +
                  `${p.x - p.w / 2 + tip},${p.y - p.h / 2} ` +
                  `${p.x + p.w / 2 - tip},${p.y - p.h / 2} ` +
                  `${p.x + p.w / 2},${p.y} ` +
                  `${p.x + p.w / 2 - tip},${p.y + p.h / 2} ` +
                  `${p.x - p.w / 2 + tip},${p.y + p.h / 2}`;
      return `<g>` +
        `<polygon points="${pts}" fill="${this.FC}" stroke="${this.SC}" stroke-width="${this.SW}"/>` +
        this._lbl(n.label, p.x, p.y, p.w - tip * 2 - 8) +
        `</g>`;
    }

    /** 注釈への破線コネクタ
     * 右側注釈: ノード右端 → 注釈左端
     * 左側注釈: ノード左端 → 注釈右端
     */
    _annotationEdge(fp, tp) {
      const isLeft = tp.annoSide === 'left';
      const sx = isLeft ? fp.x - fp.w / 2 : fp.x + fp.w / 2;
      const ex = isLeft ? tp.x + tp.w / 2 : tp.x - tp.w / 2;
      const sy = fp.y;
      const ey = tp.y;
      const d = Math.abs(sy - ey) < 2
        ? `M${sx} ${sy} L${ex} ${ey}`
        : `M${sx} ${sy} L${(sx + ex) / 2} ${sy} L${(sx + ex) / 2} ${ey} L${ex} ${ey}`;
      return `<g><path d="${d}" fill="none" stroke="${this.SC}" stroke-width="1.4" stroke-dasharray="5,3"/></g>`;
    }

    /* ── エッジ描画 ───────────────────────────────────── */
    _edge(edge, fp, tp, fromNode, toNode, decisionEdges, isMergeEdge) {
      let pathD, labelPos, mergeArrowSegment = null;

      const isBack     = tp.y < fp.y - 10;
      const isDecision = fromNode && fromNode.shape === 'decision' && decisionEdges;
      const mergeDecisionGap = (isMergeEdge && toNode && toNode.shape === 'decision') ? 18 : 0;
      const mergeApproachY = y => mergeDecisionGap > 0 ? Math.min(y, (tp.y - tp.h / 2) - mergeDecisionGap) : y;

      if (isDecision) {
        /*
         * goDown の決定:
         *   後継ノードの y 座標が最小（直下レイヤー）のエッジを下方向とし、
         *   全後継が同一 y（通常分岐）の場合は はい/Yes ラベルを優先する。
         * これにより、ループ継続ブランチ（No）は下、ループ出口（Yes）は横方向になる。
         */
        const targetYs   = decisionEdges.map(e => { const p = (this._positions || {})[e.to]; return p ? p.y : Infinity; });
        const minTargetY = Math.min(...targetYs);
        const allSameY   = targetYs.every(y => y === minTargetY);
        const idx        = decisionEdges.indexOf(edge);
        const isYes      = /^(はい|yes|Yes|TRUE|true|Y|y)$/.test(edge.label);
        const hasYesEdge = decisionEdges.some(e => /^(はい|yes|Yes|TRUE|true|Y|y)$/.test(e.label));
        let goDown;
        if (edge.exitHint === 'down') {
          goDown = true;
        } else if (edge.exitHint === 'right' || edge.exitHint === 'left') {
          goDown = false;
        } else {
          goDown = (!allSameY && tp.y === minTargetY)
                || (allSameY && (isYes || (!hasYesEdge && idx === 0)));
        }

        if (goDown) {
          const sx = fp.x,   sy = fp.y + fp.h / 2;
          const ex = tp.x,   ey = tp.y - tp.h / 2;
          const mY = mergeApproachY((sy + ey) / 2);
          pathD    = Math.abs(sx - ex) < 2
            ? `M${sx} ${sy} L${ex} ${ey}`
            : `M${sx} ${sy} L${sx} ${mY} L${ex} ${mY} L${ex} ${ey}`;
          if (Math.abs(sx - ex) >= 2) mergeArrowSegment = { x1: sx, y1: mY, x2: ex, y2: mY };
          labelPos = { x: sx + 6, y: sy + 14 };
        } else {
          /* ターゲットが同列または左側 (tp.x <= fp.x) の場合は右ではなく左出口を使う。
           * これにより、ループ出口 (Yes) が同列下方ノードへ向かうとき左側バイパスを通り、
           * 右側のアノテーション接続線や右方向バイパスと混在しない。 */
          const goRight = edge.exitHint === 'right' ? true
                        : edge.exitHint === 'left'  ? false
                        : tp.x > fp.x;
          const sx = goRight ? fp.x + fp.w / 2 : fp.x - fp.w / 2;
          const sy = fp.y;
          const ex = tp.x, ey = tp.y - tp.h / 2;
          /*
           * 折り返し経路を回避するバイパス:
           * 出口頂点と目標が同列またはそれより内側にある場合、外側に 30px 迂回させて
           * ループ本体ノード列との重なりを防ぐ。
           */
          const wouldFoldBack = goRight ? ex <= sx : ex >= sx;
          if (wouldFoldBack) {
            const bypassX     = goRight ? sx + 30 : sx - 30;
            const aboveTarget = mergeApproachY(ey - 12);
            if (goRight) {
              /*
               * 右方向バイパスはアノテーション破線と同一水平セグメントを共有してしまうため、
               * 右頂点から先に下方向へ抜けてからバイパスレーンへ右に出る経路にする。
               * これによりアノテーション破線（右向き）とバイパス（下向き→右向き）は
               * 始点のみ共有して直交分岐し、ラベルも注釈テキストと重ならない位置になる。
               */
              if (edge.exitHint === 'right') {
                pathD    = `M${sx} ${sy} L${bypassX} ${sy} L${bypassX} ${aboveTarget} L${ex} ${aboveTarget} L${ex} ${ey}`;
                mergeArrowSegment = { x1: bypassX, y1: aboveTarget, x2: ex, y2: aboveTarget };
                labelPos = { x: sx + 6, y: sy - 8 };
              } else {
                const bypassStartY = Math.min(sy + fp.h / 2, aboveTarget);
                pathD    = `M${sx} ${sy} L${sx} ${bypassStartY} L${bypassX} ${bypassStartY} L${bypassX} ${aboveTarget} L${ex} ${aboveTarget} L${ex} ${ey}`;
                mergeArrowSegment = { x1: bypassX, y1: aboveTarget, x2: ex, y2: aboveTarget };
                labelPos = { x: sx + 6, y: bypassStartY - 6 };
              }
            } else {
              pathD    = `M${sx} ${sy} L${bypassX} ${sy} L${bypassX} ${aboveTarget} L${ex} ${aboveTarget} L${ex} ${ey}`;
              mergeArrowSegment = { x1: bypassX, y1: aboveTarget, x2: ex, y2: aboveTarget };
              labelPos = { x: bypassX - 4, y: sy - 8 };
            }
          } else {
            const joinY = mergeApproachY(sy);
            pathD    = Math.abs(joinY - sy) < 2
              ? `M${sx} ${sy} L${ex} ${sy} L${ex} ${ey}`
              : `M${sx} ${sy} L${sx} ${joinY} L${ex} ${joinY} L${ex} ${ey}`;
            mergeArrowSegment = { x1: sx, y1: joinY, x2: ex, y2: joinY };
            labelPos = { x: goRight ? sx + 6 : sx - 6, y: Math.min(sy, joinY) - 8 };
          }
        }

      } else if (isBack) {
        /*
         * ループバックエッジ: 図全体の右外側を迂回
         * 注釈列も含めた右端の外側にレーンを取ることで、後続ノードや注釈線との
         * 交差を避ける。
         */
        const sx     = fp.x;
        const sy     = fp.y + fp.h / 2;  /* ノード下端から出発 */
        const ex     = tp.x;
        const ey     = tp.y - tp.h / 2;  /* 目標ノード上端 */
        const bypassX = Math.max(
          this._rightBypassX || 0,
          fp.x + fp.w / 2 + this.LOOPBACK_RIGHT_OFFSET,
          tp.x + tp.w / 2 + this.LOOPBACK_RIGHT_OFFSET
        );
        const downY  = sy + this.LOOPBACK_DOWN_OFFSET;
        const aboveY = ey - 10;          /* 目標ノード上端の 10px 手前で左折 */
        pathD    = `M${sx} ${sy} L${sx} ${downY} L${bypassX} ${downY} L${bypassX} ${aboveY} L${ex} ${aboveY} L${ex} ${ey}`;
        labelPos = { x: bypassX + 4, y: (downY + aboveY) / 2 };

      } else {
        /* 通常の前向きエッジ */
        const sx = fp.x, sy = fp.y + fp.h / 2;
        const ex = tp.x, ey = tp.y - tp.h / 2;
        const mY = mergeApproachY((sy + ey) / 2);
        pathD    = Math.abs(sx - ex) < 2
          ? `M${sx} ${sy} L${ex} ${ey}`
          : `M${sx} ${sy} L${sx} ${mY} L${ex} ${mY} L${ex} ${ey}`;
        if (Math.abs(sx - ex) >= 2) mergeArrowSegment = { x1: sx, y1: mY, x2: ex, y2: mY };
        labelPos = { x: (sx + ex) / 2 + 6, y: mY - 6 };
      }

      let lbl = '';
      if (edge.label) {
        /* paint-order: stroke で白抜き輪郭を付けて可読性を確保 */
        lbl = `<text x="${labelPos.x}" y="${labelPos.y}" ` +
              `font-family="${this.FONT}" font-size="11" fill="#333" ` +
              `style="paint-order:stroke" stroke="white" stroke-width="3" stroke-linejoin="round">` +
              `${this._inlineText(edge.label)}</text>`;
      }

      const markerAttr = ` marker-end="url(#arrow)"`;
      return `<g>` +
        `<path d="${pathD}" fill="none" stroke="${this.SC}" stroke-width="1.6"${markerAttr}/>` +
        lbl +
        `</g>`;
    }

    /* ── テキストラベル（複数行対応）────────────────── */
    _lbl(text, cx, cy, maxW) {
      if (!text) return '';
      const lines  = this._wrap(String(text), maxW || 120);
      const LH     = this.FS * 1.45;
      const totalH = lines.length * LH;
      const startY = cy - totalH / 2 + LH / 2;
      const tspans = lines.map((l, i) =>
        `<tspan x="${cx}" y="${(startY + i * LH).toFixed(1)}">${this._inlineText(l)}</tspan>`
      ).join('');
      return `<text text-anchor="middle" font-family="${this.FONT}" font-size="${this.FS}" fill="#111">${tspans}</text>`;
    }

    /** 左揃えテキストラベル（注釈用） */
    _lblLeft(text, x, cy, maxW) {
      if (!text) return '';
      const lines  = this._wrap(String(text), maxW || 140);
      const LH     = this.FS * 1.45;
      const totalH = lines.length * LH;
      const startY = cy - totalH / 2 + LH / 2;
      const tspans = lines.map((l, i) =>
        `<tspan x="${x}" y="${(startY + i * LH).toFixed(1)}">${this._inlineText(l)}</tspan>`
      ).join('');
      return `<text text-anchor="start" font-family="${this.FONT}" font-size="${this.FS}" fill="#111">${tspans}</text>`;
    }

    /** テキスト折り返し（'\n' を強制改行として扱う） */
    _wrap(text, maxW) {
      return wrapLines(text, maxW || 120, this.FS);
    }

    /** インラインテキスト（_x / _{...} の下付き対応） */
    _inlineText(t) {
      const s = String(t || '');
      const out = [];
      let buf = '';
      const flush = () => {
        if (!buf) return;
        out.push(this._esc(buf));
        buf = '';
      };

      for (let i = 0; i < s.length; i++) {
        const ch = s[i];

        /* \_ はリテラルの _ として扱う */
        if (ch === '\\' && i + 1 < s.length && s[i + 1] === '_') {
          buf += '_';
          i++;
          continue;
        }

        if (ch !== '_') {
          buf += ch;
          continue;
        }

        /* 行末の _ はそのまま表示 */
        if (i + 1 >= s.length) {
          buf += '_';
          continue;
        }

        /* _{...} の複数文字下付き */
        if (s[i + 1] === '{') {
          const close = s.indexOf('}', i + 2);
          if (close !== -1 && close > i + 2) {
            const sub = s.slice(i + 2, close);
            flush();
            out.push(`<tspan baseline-shift="sub" font-size="70%">${this._esc(sub)}</tspan>`);
            i = close;
            continue;
          }
          /* 閉じ括弧が無ければ通常文字として扱う */
          buf += '_';
          continue;
        }

        /* _x の1文字下付き */
        const sub = s[i + 1];
        flush();
        out.push(`<tspan baseline-shift="sub" font-size="70%">${this._esc(sub)}</tspan>`);
        i++;
      }

      flush();
      return out.join('');
    }

    _esc(t) {
      return String(t || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  }

  /* ================================================================== */
  /* Public API                                                           */
  /* ================================================================== */
  const _parser   = new Parser();
  const _layouter = new Layout();
  const _renderer = new Renderer();

  global.JFCD = {
    /** DSL 文字列を解析して AST を返す */
    parse(input)  { return _parser.parse(input); },

    /** AST からレイアウト情報を計算して返す */
    layout(ast)   { return _layouter.compute(ast); },

    /** AST + レイアウト情報から SVG 文字列を返す */
    render(ast, lr) { return _renderer.render(ast, lr); },

    /** 一括コンパイル: { ast, layout, svg } を返す */
    compile(input) {
      const ast = _parser.parse(input);
      const lr  = _layouter.compute(ast);
      const svg = _renderer.render(ast, lr);
      return { ast, layout: lr, svg };
    },
  };

})(window);
