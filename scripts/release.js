#!/usr/bin/env node
// Create a release: bump version, commit, tag, and push
//
// Usage:
//   node release.js         # patch release: 0.2.10 → 0.2.11
//   node release.js patch   # patch release: 0.2.10 → 0.2.11
//   node release.js minor   # minor release: 0.2.10 → 0.3.0
//   node release.js major   # major release: 0.2.10 → 1.0.0

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Parse bump type from args (default: patch)
const bumpType = process.argv[2] || 'patch';
if (!['major', 'minor', 'patch'].includes(bumpType)) {
  console.error(`Invalid bump type: ${bumpType}`);
  console.error('Usage: node release.js [major|minor|patch]');
  process.exit(1);
}

function run(cmd, options = {}) {
  console.log(`$ ${cmd}`);
  try {
    execSync(cmd, { cwd: rootDir, stdio: 'inherit', ...options });
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    process.exit(1);
  }
}

function runSilent(cmd) {
  return execSync(cmd, { cwd: rootDir, encoding: 'utf8' }).trim();
}

// Check for uncommitted changes
const status = runSilent('git status --porcelain');
if (status) {
  console.error('Error: Working directory has uncommitted changes.');
  console.error('Please commit or stash your changes before releasing.');
  process.exit(1);
}

// Check that CHANGELOG.md has been updated in a recent commit
const changelogCommits = runSilent('git log --oneline -10 --follow -- CHANGELOG.md');
const lastChangelogCommit = changelogCommits.split('\n')[0]?.split(' ')[0];

if (!lastChangelogCommit) {
  console.error('Error: CHANGELOG.md has never been committed.');
  console.error('Please update CHANGELOG.md with release notes before releasing.');
  process.exit(1);
}

// Check if CHANGELOG.md was updated in the last 5 commits
const recentCommits = runSilent('git log --oneline -5').split('\n').map(line => line.split(' ')[0]);
if (!recentCommits.includes(lastChangelogCommit)) {
  console.error('Error: CHANGELOG.md has not been updated recently.');
  console.error(`Last CHANGELOG.md update was in commit ${lastChangelogCommit}.`);
  console.error('Please update CHANGELOG.md with release notes before releasing.');
  process.exit(1);
}

// Check we're on main branch
const branch = runSilent('git branch --show-current');
if (branch !== 'main') {
  console.error(`Error: Releases should be made from 'main' branch (currently on '${branch}').`);
  process.exit(1);
}

// Pull latest changes
console.log('\nPulling latest changes...');
run('git pull --rebase');

// Bump version
console.log(`\nBumping ${bumpType} version...`);
run(`node scripts/bump-version.js ${bumpType}`);

// Read the new version
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const newVersion = packageJson.version;
const tag = `v${newVersion}`;

// Commit version bump
console.log('\nCommitting version bump...');
run('git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json');
run(`git commit -m "Bump version to ${newVersion}"`);

// Create tag
console.log(`\nCreating tag ${tag}...`);
run(`git tag ${tag}`);

// Push commit and tag
console.log('\nPushing to remote...');
run('git push origin main --tags');

console.log(`
✅ Release ${tag} created successfully!

GitHub Actions will now:
1. Build for all platforms (macOS, Linux, Windows)
2. Create a draft release with all installers

Next steps:
1. Go to https://github.com/YOUR_ORG/CANdor/releases
2. Review the draft release
3. Edit release notes if needed
4. Publish the release
`);
