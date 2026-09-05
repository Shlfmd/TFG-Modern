# TFGM

[TerraFirmaGreg-Modern]: https://github.com/TerraFirmaGreg-Team/Modpack-Modern
[Pakku]: https://github.com/juraj-hrivnak/Pakku

This is a personal fork of [TerraFirmaGreg-Modern], aptly named "TFGM" or
"TGF-Managed" to have a wordplay (of sorts, I guess) on the original name, with
extra mods layered on top and managed with [Pakku]'s brand new fork feature
(added by yours truly!) to create a _conflict-free_, _easily maintained_ version
of TerraFirmaGreg. This modpack features the full core experience of
TerraFirmaGreg-Modern, with the addition of:

- Furniture/Building/Decoration mods
- New food and misc flavor mods
- Personal addons for Gregtech

for a fun, "slow-burn" Minecraft server with neat, grounded integrations.
TerraFirmaGreg is already a near-perfect modpack, the main intention of this
fork is to offer alternative paths to casual and creative players that want more
than just questbook progression.

## About

This repo only contains the "fork layer", the mods and settings added on top of
upstream. Pakku manages a cryptographic hash of upstream pack's latest revision
that we track, and checks it out to `.pakku/parent` when you clone and initiate
the package. That path is treated as read-only input. At export time Pakku
merges the parent's lock file with this fork's layer; our projects override
parent projects with the same slug, `excludes` drop parent projects, and our
extra projects are appended.

## Contributing

This modpack is managed via two different tools. One is Just, a command runner,
and [Pakku] for managing the modpack itself. Below you'll find the necessary
commands to _manage the modpack_, in the rare case you plan to contribute.

I've also shipped the necessary deployment scripts and binaries for the two Rust
projects I've written to manage the server itself. Those are in `bin/` as
`tfgm-harness` and `tfgmctl`. Since they are static binaries, they should run on
your system just fine. Though, I recommend against executing unverified binaries
:)

### Tracking upstream

The `parent` block in `pakku.json` tracks upstream's `main` branch (its release
branch) and pins an exact commit for reproducibility.

```bash
# Update the pinned parent to the latest upstream main:
$ java -jar pakku.jar fork sync

# Inspect the current fork configuration:
$ java -jar pakku.jar fork show
```

After a sync, review and commit the updated `pakku.json` (the new pinned commit
and parent hashes).

> [!NOTE]
> On an existing `.pakku/parent` checkout, `fork sync` may fetch without
> fast-forwarding the local branch. If `fork show` still reports the old commit,
> run `git -C .pakku/parent merge --ff-only origin/main` and sync again.

### Managing mods

```bash
# Add a mod (resolves across CurseForge and Modrinth):
$ java -jar pakku.jar add <slug-or-id>

# Remove one from the fork layer:
$ java -jar pakku.jar rm <slug>

# List everything in the fork layer:
$ java -jar pakku.jar ls

# Exclude or re-include a parent project without touching upstream:
$ java -jar pakku.jar fork exclude <slug>
$ java -jar pakku.jar fork include <slug>
```

> [!IMPORTANT]
> `pakku add` resolves dependencies against this fork's lock only, not the
> parent. It can pull in libraries the parent already ships, duplicating them
> into the fork layer. Prune anything already provided by the parent so the
> layer holds only genuine additions.

### Building locally

```bash
# Make sure .pakku/parent exists and is current
$ java -jar pakku.jar fork sync

# Writes build/{curseforge,modrinth,serverpack}/
$ java -jar pakku.jar export
```
