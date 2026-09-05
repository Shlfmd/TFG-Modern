host       := env_var_or_default("TFGM_HOST", "poseidon")
repo       := env_var_or_default("TFGM_REPO", "Shlfmd/TFGM")
dir        := env_var_or_default("TFGM_DIR", "/home/notashelf/tfg")
backups    := env_var_or_default("TFGM_BACKUPS", "/home/notashelf/backups/tfgm")
run_user   := env_var_or_default("TFGM_USER", "notashelf")
service    := env_var_or_default("TFGM_SERVICE", "tfgm")
java       := env_var_or_default("TFGM_JAVA", "java")
forge_ver  := env_var_or_default("TFGM_FORGE", "1.20.1-47.4.13")
rcon_port  := env_var_or_default("TFGM_RCON_PORT", "25575")
systemctl  := env_var_or_default("TFGM_SYSTEMCTL", "sudo systemctl")
journalctl := env_var_or_default("TFGM_JOURNALCTL", "journalctl")

# Harness runs the JVM and serves the API.
_spawn :="sudo systemd-run --unit=" + service + " --collect -p Description='TFGM Minecraft server' -p Type=simple -p User=" + run_user + " -p WorkingDirectory=" + dir + " -p Environment=TFGM_HARNESS_CONFIG=" + dir + "/harness.json -p EnvironmentFile=-" + dir + "/.harness-env -p 'ExecStartPre=+" + dir + "/tfgm-firewall.sh open' -p 'ExecStopPost=+" + dir + "/tfgm-firewall.sh close' -p Restart=on-failure -p RestartSec=5 -p KillSignal=SIGTERM -p TimeoutStopSec=120 -p SuccessExitStatus='0 143' " + dir + "/tfgm-harness run"

default:
    @just --list

# Export the pack and check the serverpack for junk.
export:
    #!/usr/bin/env bash
    set -euo pipefail
    test -f .pakku/parent/pakku-lock.json || { echo "error: .pakku/parent missing, run: java -jar pakku.jar fork sync" >&2; exit 1; }
    java -jar pakku.jar export
    just scan-export

# pakku export ignores .gitignore, so fail if it bundled cache/history dirs.
scan-export:
    #!/usr/bin/env bash
    set -euo pipefail
    name=$(jq -r .name pakku.json); version=$(jq -r .version pakku.json)
    zip="build/serverpack/${name}-${version}.zip"
    test -f "$zip" || { echo "error: no serverpack at $zip" >&2; exit 1; }
    if unzip -l "$zip" | grep -Eiq '/(cache|history)/'; then
        echo "error: $zip contains cache/history paths, clean config/ and re-export:" >&2
        unzip -l "$zip" | grep -Ei '/(cache|history)/' >&2
        exit 1
    fi
    echo "clean: $zip ($(du -h "$zip" | cut -f1))"

# Host downloads a released serverpack and swaps the content dirs it ships.
# mods is mandatory; world*/ and launcher files stay. Restart after.
deploy tag="latest":
    #!/usr/bin/env bash
    set -euo pipefail
    tag="{{tag}}"
    if [ "$tag" = "latest" ]; then
        tag=$(gh release view --repo {{repo}} --json tagName -q .tagName)
    fi
    asset=$(gh release view "$tag" --repo {{repo}} --json assets -q '.assets[].name | select(test("serverpack.*\\.zip$"))' | head -1)
    test -n "$asset" || { echo "error: no serverpack asset in release $tag" >&2; exit 1; }
    url="https://github.com/{{repo}}/releases/download/$tag/$asset"
    echo "deploying $tag ($asset), downloaded on {{host}}"
    ssh {{host}} bash -s -- {{dir}} "$url" "$asset" <<'REMOTE'
    set -euo pipefail
    dir="$1"; url="$2"; asset="$3"
    cd "$dir"
    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
    nix-shell -p curl --run "curl -fSL --retry 3 -o '$tmp/$asset' '$url'"
    # mods/ is mandatory; verify before removing anything.
    nix-shell -p unzip --run "unzip -l '$tmp/$asset' 'mods/*'" >/dev/null 2>&1 || { echo "error: $asset has no mods/, aborting" >&2; exit 1; }
    # Content dirs to swap. mods is mandatory; the rest are swapped only if the
    # archive ships them. Never world*/ or host launcher files (server.properties,
    # start_server.*, minecraft_server.jar, forge-auto-install.txt).
    managed="mods config defaultconfigs kubejs tacz DiscordIntegration-Data"
    swapped=""
    for d in $managed; do
        if nix-shell -p unzip --run "unzip -l '$tmp/$asset' '$d/*'" >/dev/null 2>&1; then
            rm -rf "$d"
            nix-shell -p unzip --run "unzip -o '$tmp/$asset' '$d/*' -d ."
            swapped="$swapped $d"
        elif [ "$d" = "mods" ]; then
            echo "error: mods/ vanished from archive, aborting" >&2; exit 1
        fi
    done
    echo "swapped:$swapped from $asset"
    REMOTE
    echo "deployed $tag on {{host}}, start or restart to apply"

# SSH to the host and start.
start:
    ssh -t {{host}} "{{_spawn}}"

# Stop the unit if running, then re-spawn it.
restart:
    ssh -t {{host}} "sudo systemctl stop {{service}} 2>/dev/null || true ; {{_spawn}}"

stop:
    ssh -t {{host}} {{systemctl}} stop {{service}}

status:
    ssh -t {{host}} {{systemctl}} status {{service}} --no-pager

# Tail the server journal (last N lines, then follow).
logs lines="80":
    ssh -t {{host}} {{journalctl}} -u {{service}} -n {{lines}} -f

# Archive world + server state into the backups dir on the host, keeping the 10
# newest. Run `just stop` first for a cold, consistent snapshot.
backup:
    #!/usr/bin/env bash
    set -euo pipefail
    ssh {{host}} bash -s -- {{dir}} {{backups}} <<'REMOTE'
    set -euo pipefail
    dir="$1"; backups="$2"
    cd "$dir"
    mkdir -p "$backups"
    ts=$(date +%Y-%m-%d-%H%M)
    out="$backups/tfgm-$ts.tar.zst"
    items=()
    for p in world world_nether world_the_end config server.properties eula.txt \
             ops.json whitelist.json banned-players.json banned-ips.json usercache.json server-icon.png; do
        [ -e "$p" ] && items+=("$p")
    done
    if [ ${#items[@]} -eq 0 ]; then echo "error: nothing to back up in $dir" >&2; exit 1; fi
    nix-shell -p zstd gnutar --run "tar --zstd -cf '$out' ${items[*]}"
    echo "backup: $out ($(du -h "$out" | cut -f1))"
    ls -1t "$backups"/tfgm-*.tar.zst 2>/dev/null | tail -n +11 | xargs -r rm -f
    REMOTE

# One RCON command via the harness, e.g. `just cmd list`.
cmd +command:
    ssh {{host}} "export TFGM_HARNESS_CONFIG={{dir}}/harness.json && set -a && . {{dir}}/.harness-env && set +a && {{dir}}/tfgm-harness cmd {{command}}"

# Restart the JVM in place; the unit and firewall stay up.
mc-restart:
    ssh {{host}} "TFGM_HARNESS_CONFIG={{dir}}/harness.json {{dir}}/tfgm-harness restart"

# RCON console (tfgmctl over the SSH relay).
console:
    bin/tfgmctl --host {{host}} --service {{service}} --rcon-port {{rcon_port}}

# Install the Forge dedicated server runtime on the host (once).
bootstrap:
    #!/usr/bin/env bash
    set -euo pipefail
    url="https://maven.minecraftforge.net/net/minecraftforge/forge/{{forge_ver}}/forge-{{forge_ver}}-installer.jar"
    ssh {{host}} "mkdir -p {{dir}} && cd {{dir}} && \
        { command -v curl >/dev/null && curl -fSL -o forge-installer.jar '$url' || wget -O forge-installer.jar '$url'; } && \
        {{java}} -jar forge-installer.jar --installServer && rm -f forge-installer.jar run.bat && \
        printf 'eula=true\n' > eula.txt && echo installed"
    echo "Forge {{forge_ver}} installed on {{host}}. Next: just setup-rcon && just stage && just deploy && just start"

# Enable RCON in server.properties, generating ./.rcon-secret if absent.
setup-rcon:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f .rcon-secret ]; then
        { command -v openssl >/dev/null && openssl rand -hex 24 || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; } > .rcon-secret
        echo "generated .rcon-secret"
    fi
    chmod 600 .rcon-secret
    pass=$(tr -d '\n' < .rcon-secret)
    ssh {{host}} "cd {{dir}} && touch server.properties && \
        sed -i '/^enable-rcon=/d;/^rcon\.port=/d;/^rcon\.password=/d;/^broadcast-rcon-to-ops=/d' server.properties && \
        printf 'enable-rcon=true\nrcon.port=%s\nrcon.password=%s\nbroadcast-rcon-to-ops=false\n' '{{rcon_port}}' '$pass' >> server.properties"
    echo "RCON enabled on {{host}} (port {{rcon_port}}, reach it over the SSH tunnel and keep the port firewalled). Restart to apply."

# Render the host scripts with nix-store paths them, harness.json, and the harness binary to the host.
stage:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "resolving store paths on {{host}} (openjdk17, bubblewrap, nftables, gawk)"
    paths=$(ssh {{host}} bash -s <<'REMOTE'
    set -euo pipefail
    ef="--extra-experimental-features"
    mkdir -p ~/.tfgm-gcroots
    # `^out` pins the single `out` output; multi-output pkgs (gawk has out/man/info)
    # would otherwise emit several paths and misalign the read below.
    j=$(nix build $ef 'nix-command flakes' --print-out-paths --out-link ~/.tfgm-gcroots/jdk17 'nixpkgs#openjdk17^out')
    b=$(nix build $ef 'nix-command flakes' --print-out-paths --out-link ~/.tfgm-gcroots/bwrap 'nixpkgs#bubblewrap^out')
    n=$(nix build $ef 'nix-command flakes' --print-out-paths --out-link ~/.tfgm-gcroots/nft 'nixpkgs#nftables^out')
    g=$(nix build $ef 'nix-command flakes' --print-out-paths --out-link ~/.tfgm-gcroots/gawk 'nixpkgs#gawk^out')
    s=$(nix build $ef 'nix-command flakes' --print-out-paths --out-link ~/.tfgm-gcroots/bash 'nixpkgs#bash^out')
    echo "$j $b $n $g $s"
    REMOTE
    )
    read -r JAVA BWRAP NFT GAWK BASH <<<"$paths"
    test -n "$JAVA" && test -n "$BWRAP" && test -n "$NFT" && test -n "$GAWK" && test -n "$BASH" || { echo "error: failed to resolve store paths: '$paths'" >&2; exit 1; }
    echo "  jdk17=$JAVA"
    tmp=$(mktemp -d)
    sed -e "s|@BASH@|$BASH|g" -e "s|@DIR@|{{dir}}|g" -e "s|@JAVA@|$JAVA|g" -e "s|@BWRAP@|$BWRAP|g" scripts/tfgm-run.sh > "$tmp/tfgm-run.sh"
    sed -e "s|@BASH@|$BASH|g" -e "s|@NFT@|$NFT|g" -e "s|@GAWK@|$GAWK|g" scripts/tfgm-firewall.sh > "$tmp/tfgm-firewall.sh"
    printf '%s\n' \
      '{' \
      '  "server_root": "{{dir}}",' \
      '  "state_dir": "{{dir}}/harness-state",' \
      '  "snapshot_dir": "{{dir}}/harness-snapshot",' \
      '  "rail_data_dir": "{{dir}}",' \
      '  "jvm_command": "{{dir}}/tfgm-run.sh",' \
      '  "rcon_addr": "127.0.0.1:{{rcon_port}}",' \
      '  "cors_origin": ["http://localhost:5173"]' \
      '}' > "$tmp/harness.json"
    scp "$tmp/tfgm-run.sh" "$tmp/tfgm-firewall.sh" "$tmp/harness.json" bin/tfgm-harness "{{host}}:{{dir}}/"
    rm -rf "$tmp"
    ssh {{host}} "chmod +x {{dir}}/tfgm-run.sh {{dir}}/tfgm-firewall.sh {{dir}}/tfgm-harness"
    if [ -f .rcon-secret ]; then
        ssh {{host}} "umask 077; printf 'TFGM_RCON_PASSWORD=%s\n' \"$(tr -d '\n' < .rcon-secret)\" > {{dir}}/.harness-env"
    else
        echo "no .rcon-secret; run just setup-rcon, then just stage again"
    fi
    echo "staged {{host}}:{{dir}}"
