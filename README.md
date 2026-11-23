# CoMPAS TransnetBW Plugins

A Svelte/Vite monorepo of TransnetBW plugins for CoMPAS, managed with Nx.
Shared UI components, API clients and utilities live in `libs/`, imported through
TypeScript path aliases. App-specific Vite configuration lives in `apps/<app>/`.

## Apps in this workspace

- `engineering-wizard`: engineering workflows
- `template-generator`: template creation and management
- `history-viewer`: historical data
- `archive-explorer`: archive browsing and retrieval
- `location-viewer`: location details
- `location-manager`: locations and metadata
- `tsld`: single-line diagram utilities

## Setup and commands

Requires npm and Node.js 20+ (Happy DOM requires Node 20).
API client generation also requires Java 11+ on `PATH`.
Install dependencies with `npm install`.

| Command                                 | Purpose                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| `npm run run:<app>`                     | Vite dev server with HMR                                         |
| `npm run build:<app>`                   | Build one plugin into `dist/apps/<app>/`                         |
| `npm run preview:<app>`                 | Build and serve a plugin for CoMPAS integration                  |
| `npm run build`                         | Regenerate History/Archiving clients and build all seven plugins |
| `npm run mock-server`                   | Start the local API mock (`mocks/server.js`)                     |
| `npm run generate:history-api-client`   | Regenerate the History API client                                |
| `npm run generate:archiving-api-client` | Regenerate the Archiving API client                              |

Replace `<app>` with a workspace app name; npm run/preview scripts exist for
all listed apps except `tsld` (use Nx directly). For example:

```sh
npm run run:engineering-wizard
npm run build:template-generator
npm run preview:engineering-wizard
# Equivalent direct Nx target; override the preview port:
npx nx run engineering-wizard:preview --port=4300
```

Nx targets are also available as `npx nx run <project>:<target>`.
For integration, point CoMPAS at the preview URL printed in the terminal.
Preview is a local integration server, not a production deployment: changes must
be built and released to update distributions pinned to older plugin URLs/hashes.

## Plugin release tags

The GitHub deploy workflow records the main build commit in
`compas/plugins/SNAPSHOT_SHA` on `published-plugins` only when the copied build
output changes. An unchanged build leaves the existing snapshot SHA untouched.

Each build is published under `compas/plugins/<plugin>/snapshot/`. Snapshot and
version URLs have the same path depth, so relative `../` loads resolve the same
way. Use `<plugin>/snapshot/index.js` for the current snapshot; any legacy flat
`<plugin>/index.js` remains in place but is no longer updated.

Run **Release Plugin** manually from `main`, selecting a plugin and a
MAJOR/MINOR/PATCH increment. The release uses the existing published snapshot;
it does not rebuild the plugin. Before publishing it checks that the snapshot
SHA is a commit on main, that this plugin has no release tag on that SHA, that
the snapshot `index.js` is not already in a version folder, and that the next
version folder and tag are free. Versions are calculated independently from
each plugin's existing version folders. Versions exceeding Bash's integer range
stop the release rather than overflowing.

The whole snapshot, including extra files and subdirectories, is copied into
the version folder. Its `package.json` version is set to the release version;
the snapshot manifest stays as built. CI includes the source plugin manifest
when the build does not emit one. Missing or invalid snapshot manifests stop
the release before publishing.

The version folder is committed and pushed to `published-plugins` first.
Only after that push succeeds is the annotated `<PLUGIN_NAME>-<VERSION>` tag
created on `SNAPSHOT_SHA`, with message `Release <PLUGIN_NAME> <VERSION>` and
tagger `github-actions[bot]`. There is no new commit on main. Different plugins
may have different tags on the same main commit.

Deploy and release retain the shared `plugin-publication` concurrency group.
A normal, non-forced publication push also rejects conflicting parallel
updates before tagging. A failed tag push is not repaired automatically:
the published version folder remains and prevents releasing the same snapshot
again. Inspect the failed workflow before reconciling the publication and tag.

A missing `SNAPSHOT_SHA` fails closed. A changed build must be deployed with the
updated workflow before snapshots published without a source marker can be
released. Existing Pages publishing is unchanged.

Snapshot checks, version calculation, copying, publication, and tagging are
Bash steps directly in the YAML workflows, following the reference workflow,
with inline Node.js commands to validate and update release metadata.
Deploy and release each check out `published-plugins` once; there is no separate
runtime script or tools checkout.

Release and snapshot regression tests execute the actual YAML shell steps
against temporary local Git repositories. They require the installed workspace
dependencies:

```sh
node --test tools/plugin-release.test.mjs
```

## Engineering Wizard validation

The wizard uses the legacy Validation Service endpoint **`POST /api/v1/validate`**
so it works with the backend currently deployed on the test stage.
Requests use multipart fields `validationType=XPATH`, `sclFile`,
`rulesJson=[{"context":"//SCL","assertion":"true()"}]` and `sclFileExtension=SCD`.
The new typed validation endpoints are not required.

Automatic expert-mode syntax checks are disabled because the legacy backend has
no syntax-only endpoint. Next/Save requires a nonempty context, assertion and
error message; use the document test to evaluate the rule.

Process start validates all plugins; document changes trigger debounced
whole-process revalidation. No rules means no request. Each rule is submitted
separately because the legacy response has no per-rule outcomes. Results retain
their submitted order, so duplicate titles are safe and plugin statuses remain
visible. A plugin only passes when all its rules pass. Request failures affect
all submitted rules; retry repeats validation for the whole process.
HTTP `413` responses may have an empty body.

Build-time endpoint settings default to the same-origin gateway:

| Environment variable      | Default                                     |
| ------------------------- | ------------------------------------------- |
| `VITE_VALIDATION_API_URL` | `/compas-validation-service/api/v1/validate` |

Development overrides: `apps/engineering-wizard/.env.development`. For custom
endpoints, set `VITE_VALIDATION_API_URL`.
Cross-origin development requires matching CORS/authentication configuration.
The backend requires `SCL_VALIDATION`; the wizard retains fetch/gateway
authentication and does not store bearer tokens.

## Plugin color roles

Engineering Wizard and Template Generator share `libs/theme/src/lib/plugin-theme.css`,
loaded inside plugin shadow roots and by standalone entry points. For each
palette input, `--oscd-theme-*` takes precedence over `--oscd-*`, followed by
light/dark defaults. Host navigation tokens are not used.

| Plugin role                   | Host input                    | Usage                                                |
| ----------------------------- | ----------------------------- | ---------------------------------------------------- |
| `--oscd-plugin-action`        | `--oscd-secondary`            | Primary CTA fills and interactive accents            |
| `--oscd-plugin-brand`         | `--oscd-primary`              | Structural headers, selected cards and brand accents |
| `--oscd-plugin-text`          | `--oscd-base03`               | Headings and body text                               |
| `--oscd-plugin-text-muted`    | `--oscd-base01`               | Secondary text                                       |
| `--oscd-plugin-surface`       | `--oscd-base3`                | Content surfaces                                     |
| `--oscd-plugin-surface-muted` | `--oscd-base2`                | Muted cards and chips                                |
| `--oscd-plugin-on-action`     | `--oscd-base3`                | Ink on action fills                                  |
| `--oscd-plugin-on-brand`      | `--oscd-base3`                | Ink on brand fills                                   |
| `--oscd-plugin-error`         | `--oscd-error` / `--oscd-red` | Error states                                         |

**Brand = primary; action = secondary** is this pair of plugins' convention,
not a universal OpenSCD rule. Wizard action colors cover enabled external-plugin
add buttons, active steps/chips and Done; structural stepper backgrounds use
brand, disabled controls stay muted. Text and neutral surfaces adapt to light/dark
mode. Preserve disabled/destructive states and use contrasting fill/ink pairs:
arbitrary customer colors cannot guarantee contrast.

The adapter maps roles to SMUI `--mdc-*` variables and retains `--primary-base`
as a **brand**, not action, alias. Use role tokens in new styles, not primary as
a general text/surface color; the host's `--primary` is unchanged. External
plugins receive restored host Material mappings at the Wizard mount boundary;
Wizard loading/error controls keep its own palette. Plugins without the adapter
retain their Material defaults.

Material hover/focus/pressed layers follow local button colors, without a global
state-layer override. Keyboard focus has an explicit outline; native-button
pressed styles exclude Material buttons to avoid gray CTA fills.

`OscdBaseDialog` and `OscdConfirmDialog` use brand headers and action confirm
buttons. Independent `headerColor` / `confirmButtonColor` overrides take
precedence over legacy `color`, which still overrides both regions. Explicit
colors use white text/close icons in both modes and must contrast with white;
otherwise on-brand/on-action roles apply.
