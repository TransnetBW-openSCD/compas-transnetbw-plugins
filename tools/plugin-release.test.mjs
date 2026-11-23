import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const plugin = 'history-viewer';
const bundle = 'export default class Plugin {};\n';
const publicationRef = 'refs/heads/published-plugins';
const mainWorkflow = YAML.parse(
  readFileSync(
    new URL('../.github/workflows/main.yml', import.meta.url),
    'utf8',
  ),
);
const releaseWorkflow = YAML.parse(
  readFileSync(
    new URL('../.github/workflows/release-plugin.yml', import.meta.url),
    'utf8',
  ),
);
const deploySteps = mainWorkflow.jobs.deploy.steps.filter((step) => step.run);
const manifestSteps = mainWorkflow.jobs['build-and-test'].steps.filter(
  (step) => step.id === 'include_manifests',
);
const releaseSteps = releaseWorkflow.jobs.release.steps.filter(
  (step) => step.run,
);
const preflightSteps = releaseSteps.slice(
  0,
  releaseSteps.findIndex((step) => step.id === 'copy_plugin'),
);

function workflowContext(options) {
  return {
    variables: {
      'github.sha': options.env.SOURCE_SHA,
      'inputs.PLUGIN_NAME_TO_RELEASE': options.env.PLUGIN_NAME,
      'inputs.RELEASE_TYPE': options.env.RELEASE_TYPE,
    },
    outputOffset: existsSync(options.env.GITHUB_OUTPUT)
      ? readFileSync(options.env.GITHUB_OUTPUT, 'utf8').length
      : 0,
  };
}

function collectOutputs(step, options, context) {
  if (!existsSync(options.env.GITHUB_OUTPUT)) return;
  const contents = readFileSync(options.env.GITHUB_OUTPUT, 'utf8');
  for (const line of contents.slice(context.outputOffset).split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`Unsupported workflow output: ${line}`);
    const name = line.slice(0, separator);
    context.variables[`steps.${step.id}.outputs.${name}`] = line.slice(
      separator + 1,
    );
  }
  context.outputOffset = contents.length;
}

function shellOptions(step, options, context) {
  const env = { ...options.env };
  for (const [name, value] of Object.entries(step.env ?? {})) {
    env[name] = value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
      if (context.variables[expression] === undefined) {
        throw new Error(`Unsupported workflow expression: ${expression}`);
      }
      return context.variables[expression];
    });
  }
  return { ...options, env };
}

const shellArgs = (step) => [
  '--noprofile',
  '--norc',
  '-e',
  '-o',
  'pipefail',
  '-c',
  step.run,
];

function runSteps(steps, options) {
  const context = workflowContext(options);
  const output = { status: 0, stdout: '', stderr: '' };
  for (const step of steps) {
    const result = spawnSync(
      'bash',
      shellArgs(step),
      shellOptions(step, options, context),
    );
    if (result.error) throw result.error;
    collectOutputs(step, options, context);
    output.stdout += result.stdout;
    output.stderr += result.stderr;
    output.status = result.status;
    if (result.status !== 0) break;
  }
  return output;
}

async function startSteps(steps, options) {
  const context = workflowContext(options);
  const output = { status: 0, stdout: '', stderr: '' };
  for (const step of steps) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        'bash',
        shellArgs(step),
        shellOptions(step, options, context),
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    collectOutputs(step, options, context);
    output.stdout += result.stdout;
    output.stderr += result.stderr;
    output.status = result.status;
    if (result.status !== 0) break;
  }
  return output;
}

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'transnetbw-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  mkdirSync(source);
  const gitAt = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const git = (...args) => gitAt(source, ...args);
  const remoteGit = (...args) => gitAt(root, '--git-dir', remote, ...args);
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  writeFileSync(join(source, 'README.md'), 'Initial build source\n');
  git('add', '.');
  git('commit', '-m', 'Initial main source');
  const snapshotSha = git('rev-parse', 'HEAD');
  writeFileSync(join(source, 'README.md'), 'Documentation-only change\n');
  git('commit', '-am', 'Update documentation');
  const mainSha = git('rev-parse', 'HEAD');
  git('switch', '--orphan', 'published-plugins');
  for (const name of [plugin, 'engineering-wizard']) {
    const directory = join(source, 'compas/plugins', name, 'snapshot');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'index.js'), bundle);
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name, version: '0.0.1' }) + '\n',
    );
  }
  writeFileSync(
    join(source, 'compas/plugins/SNAPSHOT_SHA'),
    `${snapshotSha}\n`,
  );
  writeFileSync(join(source, '.gitignore'), 'dist/\napps/\n');
  git('add', '.');
  git('commit', '-m', 'Published snapshot');
  gitAt(root, 'init', '--bare', '--initial-branch=main', remote);
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main', 'published-plugins');
  let runs = 0;
  const options = (overrides = {}, cwd = source) => ({
    cwd,
    encoding: 'utf8',
    env: {
      ...env,
      PLUGIN_NAME: plugin,
      RELEASE_TYPE: 'MINOR',
      GITHUB_OUTPUT: join(root, `github-output-${runs++}`),
      SOURCE_SHA: mainSha,
      ...overrides,
    },
  });
  const run = (mode = 'prepare', overrides = {}, cwd = source) => {
    const config = options(overrides, cwd);
    if (mode === 'deploy') return runSteps(deploySteps, config);
    if (mode === 'manifests') return runSteps(manifestSteps, config);
    if (mode === 'release') return runSteps(releaseSteps, config);
    if (mode === 'prepare') return runSteps(preflightSteps, config);
    throw new Error(`Unsupported test mode: ${mode}`);
  };
  const start = (overrides, cwd) =>
    startSteps(releaseSteps, options(overrides, cwd));
  const publishFiles = () => {
    git('add', 'compas/plugins');
    git('commit', '-m', 'Existing publication');
    git('push', 'origin', `HEAD:${publicationRef}`);
  };
  const version = (name, contents = `old build ${name}\n`) => {
    const directory = join(source, 'compas/plugins', plugin, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'index.js'), contents);
  };
  const build = (contents = bundle) => {
    for (const name of [plugin, 'engineering-wizard']) {
      const directory = join(source, 'dist/apps', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'index.js'),
        name === plugin ? contents : bundle,
      );
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ name, version: '0.0.1' }) + '\n',
      );
    }
  };
  return {
    root,
    source,
    remote,
    git,
    gitAt,
    remoteGit,
    run,
    start,
    version,
    publishFiles,
    build,
    snapshotSha,
    mainSha,
  };
}

function succeeded(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function failed(result, message) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, message);
}

test('unchanged build output leaves the snapshot SHA and publication commit unchanged', (t) => {
  const repo = repository(t);
  repo.version('0.0.1');
  repo.publishFiles();
  const before = repo.remoteGit('rev-parse', publicationRef);
  repo.build();
  const result = repo.run('deploy');
  succeeded(result);
  assert.match(result.stdout, /Build output unchanged/);
  assert.equal(repo.remoteGit('rev-parse', publicationRef), before);
  assert.equal(
    repo
      .remoteGit('show', `${publicationRef}:compas/plugins/SNAPSHOT_SHA`)
      .trim(),
    repo.snapshotSha,
  );
  assert.equal(repo.git('status', '--porcelain'), '');
});

test('changed build output records its main SHA without modifying older releases', (t) => {
  const repo = repository(t);
  repo.version('0.0.1');
  writeFileSync(
    join(repo.source, 'compas/plugins', plugin, 'snapshot', 'obsolete.txt'),
    'stale\n',
  );
  repo.publishFiles();
  repo.build('new plugin build\n');
  succeeded(repo.run('deploy'));
  assert.equal(
    repo
      .remoteGit('show', `${publicationRef}:compas/plugins/SNAPSHOT_SHA`)
      .trim(),
    repo.mainSha,
  );
  assert.equal(
    repo.remoteGit(
      'show',
      `${publicationRef}:compas/plugins/${plugin}/snapshot/index.js`,
    ),
    'new plugin build',
  );
  assert.equal(
    repo.remoteGit(
      'show',
      `${publicationRef}:compas/plugins/${plugin}/0.0.1/index.js`,
    ),
    'old build 0.0.1',
  );
  assert.throws(() =>
    repo.remoteGit(
      'show',
      `${publicationRef}:compas/plugins/${plugin}/snapshot/obsolete.txt`,
    ),
  );
  assert.equal(repo.remoteGit('rev-parse', 'main'), repo.mainSha);
});

test('deploy migrates to nested snapshots while keeping legacy flat files and all build assets', (t) => {
  const repo = repository(t);
  repo.git('rm', '-r', 'compas/plugins/history-viewer/snapshot');
  mkdirSync(join(repo.source, 'compas/plugins', plugin), { recursive: true });
  writeFileSync(
    join(repo.source, 'compas/plugins', plugin, 'index.js'),
    'legacy flat build\n',
  );
  repo.publishFiles();
  repo.build();
  const directory = join(repo.source, 'dist/apps', plugin);
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'assets/icon.svg'), '<svg />\n');
  writeFileSync(join(directory, '.metadata'), 'hidden build metadata\n');
  succeeded(repo.run('deploy'));
  for (const [path, contents] of [
    ['index.js', 'legacy flat build'],
    ['snapshot/index.js', bundle.trim()],
    ['snapshot/assets/icon.svg', '<svg />'],
    ['snapshot/.metadata', 'hidden build metadata'],
  ]) {
    assert.equal(
      repo.remoteGit(
        'show',
        `${publicationRef}:compas/plugins/${plugin}/${path}`,
      ),
      contents,
    );
  }
  assert.equal(
    repo.remoteGit('show', `${publicationRef}:compas/plugins/SNAPSHOT_SHA`),
    repo.mainSha,
  );
});

test('CI supplies missing source manifests without replacing emitted manifests', (t) => {
  const repo = repository(t);
  repo.build();
  const output = join(repo.source, 'dist/apps', plugin, 'package.json');
  unlinkSync(output);
  const source = join(repo.source, 'apps', plugin);
  mkdirSync(source, { recursive: true });
  const manifest = JSON.stringify({
    name: plugin,
    version: '0.0.1',
    main: './index.js',
  });
  writeFileSync(join(source, 'package.json'), manifest);
  const emitted = join(
    repo.source,
    'dist/apps/engineering-wizard/package.json',
  );
  const before = readFileSync(emitted);
  succeeded(repo.run('manifests'));
  assert.equal(readFileSync(output, 'utf8'), manifest);
  assert.deepEqual(readFileSync(emitted), before);
  unlinkSync(output);
  unlinkSync(join(source, 'package.json'));
  failed(repo.run('manifests'), /No such file/);
});

test('release copies all snapshot contents and changes only the released manifest version', (t) => {
  const repo = repository(t);
  const directory = join(repo.source, 'compas/plugins', plugin, 'snapshot');
  const manifest = {
    name: plugin,
    version: '0.0.1',
    main: './index.js',
    custom: { enabled: true },
  };
  const snapshotManifest = JSON.stringify(manifest) + '\n';
  writeFileSync(join(directory, 'package.json'), snapshotManifest);
  mkdirSync(join(directory, 'assets'));
  const files = [
    ['index.js', bundle],
    ['style.css', 'body { color: red; }\n'],
    ['assets/icon.svg', '<svg />\n'],
    ['.metadata', 'hidden metadata\n'],
  ];
  for (const [path, contents] of files)
    writeFileSync(join(directory, path), contents);
  repo.publishFiles();
  succeeded(repo.run('release'));
  for (const [path] of files) {
    assert.deepEqual(
      readFileSync(join(repo.source, 'compas/plugins', plugin, '0.1.0', path)),
      readFileSync(join(directory, path)),
    );
  }
  assert.deepEqual(
    JSON.parse(
      repo.remoteGit(
        'show',
        `${publicationRef}:compas/plugins/${plugin}/0.1.0/package.json`,
      ),
    ),
    { ...manifest, version: '0.1.0' },
  );
  assert.equal(
    readFileSync(join(directory, 'package.json'), 'utf8'),
    snapshotManifest,
  );
  const base = 'https://example.invalid/compas/plugins/';
  assert.equal(
    new URL('../shared.json', `${base}${plugin}/snapshot/index.js`).href,
    new URL('../shared.json', `${base}${plugin}/0.1.0/index.js`).href,
  );
});

test('missing, malformed or non-object snapshot manifests fail before publication', (t) => {
  const repo = repository(t);
  const manifest = join(
    repo.source,
    'compas/plugins',
    plugin,
    'snapshot/package.json',
  );
  const before = repo.remoteGit('rev-parse', publicationRef);
  unlinkSync(manifest);
  failed(repo.run('release'), /Snapshot package.json is missing/);
  for (const invalid of ['{', 'null', '[]']) {
    writeFileSync(manifest, invalid);
    failed(repo.run('release'), /SyntaxError|must contain an object/);
  }
  assert.equal(repo.remoteGit('rev-parse', publicationRef), before);
  assert.equal(repo.remoteGit('tag', '--list'), '');
  assert.equal(
    existsSync(join(repo.source, 'compas/plugins', plugin, '0.1.0')),
    false,
  );
});

test('an unchanged build cannot invent a source marker for a legacy snapshot', (t) => {
  const repo = repository(t);
  unlinkSync(join(repo.source, 'compas/plugins/SNAPSHOT_SHA'));
  repo.publishFiles();
  const before = repo.remoteGit('rev-parse', publicationRef);
  repo.build();
  succeeded(repo.run('deploy'));
  assert.equal(repo.remoteGit('rev-parse', publicationRef), before);
  failed(repo.run(), /SNAPSHOT_SHA is missing/);
});

test('an empty build output fails without changing the published snapshot', (t) => {
  const repo = repository(t);
  const before = repo.remoteGit('rev-parse', publicationRef);
  mkdirSync(join(repo.source, 'dist/apps'), { recursive: true });
  failed(repo.run('deploy'), /No plugin build output/);
  assert.equal(repo.remoteGit('rev-parse', publicationRef), before);
});

test('preflight calculates initial versions from an older main snapshot without publishing', (t) => {
  const repo = repository(t);
  const before = repo.remoteGit('show-ref');
  const status = repo.git('status', '--porcelain');
  const output = join(repo.root, 'github-output');
  for (const [type, version] of [
    ['MAJOR', '1.0.0'],
    ['MINOR', '0.1.0'],
    ['PATCH', '0.0.1'],
  ]) {
    const result = repo.run('prepare', {
      RELEASE_TYPE: type,
      GITHUB_OUTPUT: output,
    });
    succeeded(result);
    assert.ok(
      result.stdout.includes(`${plugin}-${version} at ${repo.snapshotSha}`),
    );
  }
  assert.match(readFileSync(output, 'utf8'), /NEW_RELEASE_VERSION=0\.0\.1/);
  assert.equal(repo.remoteGit('show-ref'), before);
  assert.equal(repo.git('status', '--porcelain'), status);
});

test('versions are sorted numerically and are independent of other plugins', (t) => {
  const repo = repository(t);
  repo.version('1.9.9');
  repo.version('1.10.2');
  repo.publishFiles();
  repo.git('tag', 'engineering-wizard-99.0.0', repo.snapshotSha);
  repo.git('push', 'origin', '--tags');
  for (const [type, version] of [
    ['MAJOR', '2.0.0'],
    ['MINOR', '1.11.0'],
    ['PATCH', '1.10.3'],
  ]) {
    const result = repo.run('prepare', { RELEASE_TYPE: type });
    succeeded(result);
    assert.ok(result.stdout.includes(`${plugin}-${version}`));
  }
});

test('legacy leading-zero versions are incremented as decimal numbers', (t) => {
  const repo = repository(t);
  repo.version('1.08.09');
  repo.publishFiles();
  for (const [type, version] of [
    ['MAJOR', '2.0.0'],
    ['MINOR', '1.9.0'],
    ['PATCH', '1.8.10'],
  ]) {
    const result = repo.run('prepare', { RELEASE_TYPE: type });
    succeeded(result);
    assert.ok(result.stdout.includes(`${plugin}-${version}`));
  }
});

test('oversized components and integer overflow fail before publication', (t) => {
  for (const [version, releaseType, message] of [
    [
      '18446744073709551617.0.0',
      'MINOR',
      /component exceeds Bash integer range/,
    ],
    [
      '9223372036854775807.0.0',
      'MAJOR',
      /increment exceeds Bash integer range/,
    ],
  ]) {
    const repo = repository(t);
    repo.version(version);
    repo.publishFiles();
    const before = repo.remoteGit('rev-parse', publicationRef);
    failed(repo.run('release', { RELEASE_TYPE: releaseType }), message);
    assert.equal(repo.remoteGit('rev-parse', publicationRef), before);
    assert.equal(repo.remoteGit('tag', '--list'), '');
  }
});

test('missing or malformed snapshot markers abort without a release', (t) => {
  const repo = repository(t);
  const marker = join(repo.source, 'compas/plugins/SNAPSHOT_SHA');
  unlinkSync(marker);
  failed(repo.run(), /SNAPSHOT_SHA is missing/);
  writeFileSync(marker, 'not-a-sha\n');
  failed(repo.run(), /is not a commit SHA/);
  assert.equal(repo.remoteGit('tag', '--list'), '');
});

test('a snapshot commit outside main is rejected', (t) => {
  const repo = repository(t);
  repo.git('switch', '--orphan', 'unmerged');
  writeFileSync(join(repo.source, 'unmerged.txt'), 'unmerged\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'Unmerged source');
  const sha = repo.git('rev-parse', 'HEAD');
  repo.git('switch', 'published-plugins');
  writeFileSync(join(repo.source, 'compas/plugins/SNAPSHOT_SHA'), `${sha}\n`);
  failed(repo.run(), /is not on main/);
});

test('invalid inputs fail instead of silently selecting a release type', (t) => {
  const repo = repository(t);
  failed(
    repo.run('prepare', { PLUGIN_NAME: '../other' }),
    /Unsupported plugin/,
  );
  failed(
    repo.run('prepare', { RELEASE_TYPE: 'OTHER' }),
    /Unsupported release type/,
  );
  repo.build();
  failed(
    repo.run('deploy', { SOURCE_SHA: 'invalid' }),
    /full main build commit SHA/,
  );
  assert.equal(repo.remoteGit('tag', '--list'), '');
});

test('an existing annotated tag on this plugin snapshot SHA prevents another release', (t) => {
  const repo = repository(t);
  repo.git(
    'tag',
    '-a',
    `${plugin}-1.0.0`,
    repo.snapshotSha,
    '-m',
    'Earlier release',
  );
  repo.git('push', 'origin', '--tags');
  failed(repo.run(), /already tagged/);
});

test('identical snapshot bytes on a newer documentation-only main commit cannot be released again', (t) => {
  const repo = repository(t);
  repo.version('0.0.1', bundle);
  repo.publishFiles();
  writeFileSync(
    join(repo.source, 'compas/plugins/SNAPSHOT_SHA'),
    `${repo.mainSha}\n`,
  );
  failed(repo.run(), /already released as/);
  assert.equal(repo.remoteGit('tag', '--list'), '');
});

test('occupied tag names and version paths stop preflight', (t) => {
  const repo = repository(t);
  repo.git('tag', `${plugin}-0.1.0`, repo.mainSha);
  repo.git('push', 'origin', '--tags');
  failed(repo.run(), /Tag .* already exists/);
  const other = repository(t);
  writeFileSync(
    join(other.source, 'compas/plugins', plugin, '0.1.0'),
    'occupied path',
  );
  failed(other.run(), /Version path .* already exists/);
});

test('different plugins can tag the same main snapshot without changing main', (t) => {
  const repo = repository(t);
  const style = 'body { color: red; }\n';
  writeFileSync(
    join(repo.source, 'compas/plugins', plugin, 'snapshot', 'style.css'),
    style,
  );
  repo.publishFiles();
  for (const name of [plugin, 'engineering-wizard']) {
    succeeded(repo.run('release', { PLUGIN_NAME: name }));
    assert.equal(repo.remoteGit('cat-file', '-t', `${name}-0.1.0`), 'tag');
    assert.equal(
      repo.remoteGit('rev-parse', `${name}-0.1.0^{commit}`),
      repo.snapshotSha,
    );
    assert.equal(
      repo.remoteGit(
        'for-each-ref',
        '--format=%(contents:subject)|%(taggername)',
        `refs/tags/${name}-0.1.0`,
      ),
      `Release ${name} 0.1.0|github-actions[bot]`,
    );
    assert.equal(
      repo.remoteGit(
        'show',
        `${publicationRef}:compas/plugins/${name}/0.1.0/index.js`,
      ),
      bundle.trim(),
    );
  }
  assert.equal(
    repo.remoteGit(
      'show',
      `${publicationRef}:compas/plugins/${plugin}/0.1.0/style.css`,
    ),
    style.trim(),
  );
  assert.equal(repo.remoteGit('rev-parse', 'main'), repo.mainSha);
});

test('a release calculates its version from the current folders instead of stale proposed outputs', (t) => {
  const repo = repository(t);
  succeeded(repo.run('prepare'));
  repo.version('1.8.9');
  repo.publishFiles();
  succeeded(repo.run('release'));
  assert.equal(repo.remoteGit('tag', '--list'), `${plugin}-1.9.0`);
  assert.equal(
    repo.remoteGit('rev-parse', `${plugin}-1.9.0^{commit}`),
    repo.snapshotSha,
  );
});

test('a rejected publication push creates no tag', (t) => {
  const repo = repository(t);
  const before = repo.remoteGit('rev-parse', publicationRef);
  writeFileSync(
    join(repo.remote, 'hooks', 'pre-receive'),
    '#!/bin/sh\nprintf "Publication rejected\\n" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  failed(repo.run('release'), /Publication rejected/);
  assert.equal(repo.remoteGit('rev-parse', publicationRef), before);
  assert.equal(repo.remoteGit('tag', '--list'), '');
  assert.equal(repo.git('tag', '--list'), '');
});

test('a failed tag push is not repaired and the version folder prevents a retry', (t) => {
  const repo = repository(t);
  writeFileSync(
    join(repo.remote, 'hooks', 'pre-receive'),
    '#!/bin/sh\nwhile read -r old new ref; do\n  case "$ref" in refs/tags/*) printf "Tag rejected\\n" >&2; exit 1 ;; esac\ndone\n',
    { mode: 0o755 },
  );
  failed(repo.run('release'), /Tag rejected/);
  assert.equal(repo.remoteGit('tag', '--list'), '');
  assert.equal(
    repo.remoteGit(
      'show',
      `${publicationRef}:compas/plugins/${plugin}/0.1.0/index.js`,
    ),
    bundle.trim(),
  );
  const fresh = join(repo.root, 'fresh');
  repo.gitAt(
    repo.root,
    'clone',
    '--branch',
    'published-plugins',
    repo.remote,
    fresh,
  );
  failed(repo.run('prepare', {}, fresh), /already released as/);
  assert.equal(repo.remoteGit('rev-parse', 'main'), repo.mainSha);
});

test('concurrent MINOR and MAJOR releases cannot publish two tags for the same plugin snapshot', async (t) => {
  const repo = repository(t);
  const second = join(repo.root, 'second');
  repo.gitAt(
    repo.root,
    'clone',
    '--branch',
    'published-plugins',
    repo.remote,
    second,
  );
  const hook =
    '#!/bin/sh\nset -eu\n: > "$RELEASE_BARRIER/$RELEASE_PARTICIPANT.ready"\nattempts=0\nwhile [ ! -f "$RELEASE_BARRIER/A.ready" ] || [ ! -f "$RELEASE_BARRIER/B.ready" ]; do\n  attempts=$((attempts + 1))\n  [ "$attempts" -lt 200 ] || exit 1\n  sleep 0.05\ndone\n';
  for (const cwd of [repo.source, second]) {
    writeFileSync(join(cwd, '.git', 'hooks', 'pre-push'), hook, {
      mode: 0o755,
    });
  }
  const results = await Promise.all([
    repo.start(
      { RELEASE_BARRIER: repo.root, RELEASE_PARTICIPANT: 'A' },
      repo.source,
    ),
    repo.start(
      {
        RELEASE_BARRIER: repo.root,
        RELEASE_PARTICIPANT: 'B',
        RELEASE_TYPE: 'MAJOR',
      },
      second,
    ),
  ]);
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    [0, 1],
    JSON.stringify(results),
  );
  const tags = repo.remoteGit('tag', '--list').split('\n');
  assert.equal(tags.length, 1);
  assert.equal(
    repo.remoteGit('rev-parse', `${tags[0]}^{commit}`),
    repo.snapshotSha,
  );
  const version = tags[0].slice(plugin.length + 1);
  assert.equal(
    repo.remoteGit(
      'show',
      `${publicationRef}:compas/plugins/${plugin}/${version}/index.js`,
    ),
    bundle.trim(),
  );
  const winner = results.findIndex((result) => result.status === 0);
  const checkout = winner === 0 ? repo.source : second;
  assert.equal(
    readdirSync(join(checkout, 'compas/plugins', plugin), {
      withFileTypes: true,
    }).filter(
      (entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name),
    ).length,
    1,
  );
});
