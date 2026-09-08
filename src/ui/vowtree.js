import { BRANCHES, VOW_NODES, nodeList } from '../data/vowtree.js';

/**
 * The Vow-Tree centrepiece. `renderVowTree(game, container)` builds the DOM
 * once (three branch columns of hex nodes + an SVG prerequisite web per
 * column) and caches it on the container; every later call just updates
 * classes/text so re-rendering while the panel is open stays cheap.
 */
const TIER_GAP = 128;
const COL_WIDTH = 200;

function nodesByBranch(branchId) {
  return nodeList().filter((n) => n.branch === branchId).sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));
}

function buildColumn(game, branch) {
  const col = document.createElement('div');
  col.className = 'vow-column';
  col.style.setProperty('--branch-colour', branch.colour);

  const head = document.createElement('div');
  head.className = 'vow-column-head';
  head.innerHTML = `<h3>${branch.name}</h3><p>${branch.subtitle}</p>`;
  col.appendChild(head);

  const stage = document.createElement('div');
  stage.className = 'vow-stage';
  col.appendChild(stage);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'vow-lines');
  stage.appendChild(svg);

  const nodes = nodesByBranch(branch.id);
  const maxTier = nodes.reduce((m, n) => Math.max(m, n.tier), 1);
  stage.style.height = `${maxTier * TIER_GAP + 80}px`;

  const nodeEls = new Map();
  for (const node of nodes) {
    const tierNodes = nodes.filter((n) => n.tier === node.tier);
    const lane = tierNodes.indexOf(node);
    const x = COL_WIDTH / 2 + (lane - (tierNodes.length - 1) / 2) * 110;
    const y = 40 + (node.tier - 1) * TIER_GAP;

    const hex = document.createElement('button');
    hex.type = 'button';
    hex.className = 'vow-node';
    hex.style.left = `${x}px`;
    hex.style.top = `${y}px`;
    hex.dataset.id = node.id;
    hex.innerHTML = `
      <span class="vow-node-hex"></span>
      <span class="vow-node-name">${node.name}</span>
      <span class="vow-node-cost">${node.cost}</span>
    `;
    hex.title = node.desc;
    hex.addEventListener('click', () => {
      try { game.progression?.unlock?.(node.id); } catch (err) { game.debug?.('vowtree unlock failed', err); }
    });
    stage.appendChild(hex);
    nodeEls.set(node.id, { el: hex, x, y });
  }

  // Prerequisite lines, drawn after positions are known.
  const lines = [];
  for (const node of nodes) {
    for (const reqId of node.requires) {
      const a = nodeEls.get(reqId);
      const b = nodeEls.get(node.id);
      if (!a || !b) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y + 18);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y - 18);
      line.setAttribute('class', 'vow-line');
      svg.appendChild(line);
      lines.push({ line, fromId: reqId, toId: node.id });
    }
  }
  svg.setAttribute('viewBox', `0 0 ${COL_WIDTH} ${maxTier * TIER_GAP + 80}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  return { col, nodeEls, lines };
}

function stateOf(game, node) {
  const has = (id) => { try { return !!game.progression?.has?.(id); } catch { return false; } };
  if (has(node.id)) return 'unlocked';
  const prereqsMet = node.requires.every((r) => has(r));
  if (!prereqsMet) return 'locked';
  const marks = game.progression?.oathmarks ?? 0;
  return marks >= node.cost ? 'affordable' : 'unaffordable';
}

export function renderVowTree(game, container) {
  if (!container.__vowBuilt) {
    container.innerHTML = '';
    container.classList.add('vow-tree');

    const header = document.createElement('div');
    header.className = 'vow-header';
    header.innerHTML = `<h2>The Vow-Tree</h2><div class="vow-oathmarks"><span class="vow-oathmarks-count">0</span> Oathmarks</div>`;
    container.appendChild(header);

    const columns = document.createElement('div');
    columns.className = 'vow-columns';
    container.appendChild(columns);

    const built = { columns: {} };
    for (const branch of Object.values(BRANCHES)) {
      const c = buildColumn(game, branch);
      columns.appendChild(c.col);
      built.columns[branch.id] = c;
    }
    built.oathmarksEl = header.querySelector('.vow-oathmarks-count');

    container.__vowBuilt = built;
  }

  const built = container.__vowBuilt;
  built.oathmarksEl.textContent = String(game.progression?.oathmarks ?? 0);

  for (const branch of Object.values(BRANCHES)) {
    const c = built.columns[branch.id];
    for (const node of nodesByBranch(branch.id)) {
      const ref = c.nodeEls.get(node.id);
      if (!ref) continue;
      const state = stateOf(game, node);
      ref.el.classList.remove('locked', 'affordable', 'unaffordable', 'unlocked');
      ref.el.classList.add(state);
      ref.el.disabled = state !== 'affordable';
    }
    for (const { line, fromId, toId } of c.lines) {
      const fromUnlocked = stateOf(game, VOW_NODES[fromId]) === 'unlocked';
      const toUnlocked = stateOf(game, VOW_NODES[toId]) === 'unlocked';
      line.classList.toggle('lit', fromUnlocked && toUnlocked);
      line.classList.toggle('ready', fromUnlocked && !toUnlocked);
    }
  }
}
