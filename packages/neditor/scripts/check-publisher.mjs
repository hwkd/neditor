/**
 * Refuses a publish that would freeze `catalog:` into the registry manifest.
 *
 * The four devDependencies are declared with pnpm's workspace-only `catalog:`
 * protocol. `pnpm publish` rewrites those to the real ranges in
 * pnpm-workspace.yaml before packing; `npm publish` does not — it never
 * resolves a range, so the manifest goes to the registry saying
 * `"happy-dom": "catalog:"`, a specifier npm's own parser rejects.
 *
 * Consumers are unaffected, since devDependencies are ignored on an installed
 * package. The damage is to the published artifact: registry UIs and SBOM
 * scanners read a range nothing outside a pnpm workspace can resolve, and npm
 * forbids republishing a version, so it cannot be corrected afterwards.
 *
 * The check is on the user agent rather than on a packed tarball because the
 * tarball is the wrong subject: a pack this script ran itself would be npm's
 * either way. What decides the outcome is which CLI drives the publish, and
 * that is what this reads. It fails closed — an absent user agent is not a
 * pnpm publish.
 */

const agent = process.env.npm_config_user_agent ?? '';

if (!agent.startsWith('pnpm/')) {
  const seen = agent === '' ? '(npm_config_user_agent not set)' : agent;

  console.error(
    [
      '',
      'Refusing to publish: this is not `pnpm publish`.',
      `  saw: ${seen}`,
      '',
      'The devDependencies use pnpm’s `catalog:` protocol. Only pnpm resolves it',
      'at pack time; npm ships the literal string "catalog:" to the registry, and',
      'a published version can never be replaced.',
      '',
      'Run `pnpm publish` from packages/neditor instead.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.warn(`publisher: ${agent.split(' ')[0]} — catalog: ranges will be resolved at pack time`);
