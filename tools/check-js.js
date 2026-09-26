#!/usr/bin/env node
/**
 * Syntax-check every JavaScript file in the extension and make sure that every
 * path the manifest references actually exists on disk.
 *
 *   node tools/check-js.js
 *
 * Exits non-zero on the first category of failure it finds, printing all the
 * problems it found in that category first.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const problems = [];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dict' || entry.name === 'node_modules') {
        continue; // data files, not scripts
      }
      walk(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function checkSyntax() {
  const files = walk(SRC, []);
  files.push(path.join(__dirname, 'check-js.js'));
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      problems.push('syntax: ' + path.relative(ROOT, file) + '\n' + (result.stderr || '').trim());
    }
  }
  return files.length;
}

function resolveManifest() {
  const manifestPath = path.join(SRC, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    problems.push('manifest: cannot parse manifest.json - ' + error.message);
    return null;
  }
  return manifest;
}

function requireExists(relative, why) {
  if (!fs.existsSync(path.join(SRC, relative))) {
    problems.push('missing file referenced by manifest (' + why + '): src/' + relative);
  }
}

function checkManifest(manifest) {
  if (!manifest) {
    return;
  }
  if (manifest.manifest_version !== 3) {
    problems.push('manifest: expected manifest_version 3');
  }
  for (const key of ['name', 'version', 'description']) {
    if (!manifest[key]) {
      problems.push('manifest: missing required key "' + key + '"');
    }
  }
  if (!manifest.browser_specific_settings
    || !manifest.browser_specific_settings.gecko
    || !manifest.browser_specific_settings.gecko.id) {
    problems.push('manifest: browser_specific_settings.gecko.id is required for AMO');
  }

  (manifest.content_scripts || []).forEach((block, index) => {
    (block.js || []).forEach((file) => requireExists(file, 'content_scripts[' + index + ']'));
    (block.css || []).forEach((file) => requireExists(file, 'content_scripts[' + index + '].css'));
    if (!block.run_at) {
      problems.push('manifest: content_scripts[' + index + '] has no run_at');
    }
  });

  const background = manifest.background || {};
  const bgScripts = [].concat(background.scripts || [], background.service_worker || []);
  bgScripts.forEach((file) => requireExists(file, 'background'));

  if (manifest.action) {
    if (manifest.action.default_popup) {
      requireExists(manifest.action.default_popup, 'action.default_popup');
    }
    Object.values(manifest.action.default_icon || {}).forEach((file) => requireExists(file, 'action icon'));
  }
  if (manifest.options_ui && manifest.options_ui.page) {
    requireExists(manifest.options_ui.page, 'options_ui.page');
  }
  Object.values(manifest.icons || {}).forEach((file) => requireExists(file, 'icon'));

  // web_accessible_resources patterns: only globs are used by this project.
  (manifest.web_accessible_resources || []).forEach((entry, index) => {
    (entry.resources || []).forEach((pattern) => {
      if (pattern.includes('*')) {
        const dir = path.join(SRC, path.dirname(pattern));
        if (!fs.existsSync(dir)) {
          problems.push('manifest: web_accessible_resources[' + index + '] directory missing: '
            + path.join('src', path.dirname(pattern)));
        }
        return;
      }
      requireExists(pattern, 'web_accessible_resources[' + index + ']');
    });
  });
}

function checkHtmlScripts() {
  const pages = [
    path.join(SRC, 'popup', 'popup.html'),
    path.join(SRC, 'options', 'options.html'),
  ];
  for (const page of pages) {
    if (!fs.existsSync(page)) {
      problems.push('missing page: ' + path.relative(ROOT, page));
      continue;
    }
    const html = fs.readFileSync(page, 'utf8');
    const pattern = /(?:src|href)="([^"]+)"/g;
    let match = pattern.exec(html);
    while (match) {
      const target = match[1];
      if (!/^(https?:|#|data:)/.test(target)) {
        const resolved = path.resolve(path.dirname(page), target.split('#')[0].split('?')[0]);
        if (!fs.existsSync(resolved)) {
          problems.push('missing asset in ' + path.relative(ROOT, page) + ': ' + target);
        }
      }
      match = pattern.exec(html);
    }
  }
}

function main() {
  const count = checkSyntax();
  const manifest = resolveManifest();
  checkManifest(manifest);
  checkHtmlScripts();

  console.log('checked %d JavaScript files', count);
  if (problems.length) {
    console.error('\n%d problem(s):', problems.length);
    for (const problem of problems) {
      console.error('  - ' + problem);
    }
    process.exitCode = 1;
    return;
  }
  console.log('manifest and assets OK');
}

main();
