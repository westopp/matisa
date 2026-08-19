// afterPack — stage the engine's native modules INSIDE the bundle before it is
// signed.
//
// Why a hook and not a step in package.mjs: electron-builder's copier hard-
// ignores node_modules inside extraResources, so the natives have to be put
// there by hand. That copy used to run after `electron-builder` returned —
// which is after signing. Unsigned Mach-O files appearing inside an already-
// sealed bundle break the seal: `codesign --verify` fails, notarisation
// rejects the upload, and Gatekeeper refuses to launch what does get through.
//
// afterPack runs once the app directory is assembled and before the signature
// is applied, which is the only window where adding files is free. Nothing
// about the copy itself changed — only when it happens.
//
// CommonJS because electron-builder require()s this file, and apps/shell has no
// "type": "module" (the .mjs build scripts opt in explicitly).
const { chmodSync, cpSync, existsSync, globSync } = require("node:fs")
const { join, sep } = require("node:path")

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return

  const vendorModules = join(__dirname, "..", "vendor", "engine", "node_modules")
  if (!existsSync(vendorModules)) {
    throw new Error(
      `after-pack: ${vendorModules} is missing — run scripts/package.mjs, which stages it before invoking electron-builder`
    )
  }

  const appName = context.packager.appInfo.productFilename
  const resources = join(context.appOutDir, `${appName}.app`, "Contents", "Resources")

  // Two options that are not decoration — a signed build fails without either.
  //
  // verbatimSymlinks: cpSync's DEFAULT is to rewrite a relative symlink so it
  // still resolves from the destination, which it does by making it absolute.
  // Applied here that turns node_modules/.bin/semver -> ../semver/bin/semver.js
  // into a link pointing at this machine's build directory, and `codesign
  // --verify --deep --strict` rejects the bundle outright: "invalid destination
  // for symbolic link in bundle". Copy the links as they are and they keep
  // resolving inside the app, where their targets actually are.
  //
  // filter: and then do not copy .bin at all. Those are npm's CLI shims for
  // build-time tools (prebuild-install, rc, semver) — nothing inside a packaged
  // app ever executes them, they exist only because `npm install` writes them.
  // Excluding the directory removes the whole class of problem rather than
  // relying on the option above to keep handling it.
  cpSync(vendorModules, join(resources, "engine", "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => !src.includes(`${sep}node_modules${sep}.bin`)
  })

  // Tarball extraction is known to drop the exec bit; node-pty cannot fork a
  // PTY without it, and re-applying here is cheap insurance for a failure that
  // otherwise only shows up as "terminals do not work" on someone else's Mac.
  for (const helper of globSync(
    join(resources, "engine", "node_modules", "node-pty", "prebuilds", "*", "spawn-helper")
  )) {
    chmodSync(helper, 0o755)
  }

  console.log(`  • after-pack staged engine natives → ${resources}/engine/node_modules`)
}
