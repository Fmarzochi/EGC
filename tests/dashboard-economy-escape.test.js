'use strict';

/**
 * The Economy tab renders a provider name as text: a name the panel does
 * not know falls back to the raw provider id from the telemetry, and markup
 * in it must not reach innerHTML as markup. Runs the panel's own
 * renderEconomy and esc against a minimal stand-in for the page.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'public', 'index.html'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in dashboard/public/index.html`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const IDES = [{ id: 'claude', label: 'Claude Code', c: '#7c4dff', e: '' }];

function renderEconomy(telemetry) {
  const elements = { ecoContent: { innerHTML: '' }, currentSessionEco: { innerHTML: '', style: {} } };
  const document = { getElementById: id => elements[id] };
  const render = new Function('document', 'IDES', `${extractFunction('esc')}\n${extractFunction('renderEconomy')}\nreturn renderEconomy;`)(document, IDES);
  render(telemetry);
  return elements.ecoContent.innerHTML;
}

function provider(overrides = {}) {
  return { running: true, sessions: 1, toolCalls: 2, capabilities: {}, ...overrides };
}

test('a provider id the panel does not know is rendered as text', () => {
  const html = renderEconomy({ '<img src=x onerror=alert(1)>': provider() });
  assert.ok(!html.includes('<img'), 'the markup must not reach the page');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the id is shown escaped');
});

test('a known provider keeps its label', () => {
  const html = renderEconomy({ claude: provider() });
  assert.ok(html.includes('>Claude Code</div>'), html);
});
