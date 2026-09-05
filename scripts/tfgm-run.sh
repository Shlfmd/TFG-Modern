#!@BASH@/bin/bash
# Run the server under bwrap (uid 65534, host net) on openjdk17.
set -euo pipefail
cd "@DIR@"

JVM_ARGS=()
if [ -f user_jvm_args.txt ]; then
	while IFS= read -r line; do
		line="${line%%#*}"
		for token in $line; do
			JVM_ARGS+=("$token")
		done
	done <user_jvm_args.txt
fi

exec "@BWRAP@/bin/bwrap" \
	--unshare-pid \
	--unshare-ipc \
	--unshare-uts \
	--unshare-cgroup \
	--unshare-user \
	--uid 65534 \
	--gid 65534 \
	--share-net \
	--die-with-parent \
	--ro-bind /nix /nix \
	--ro-bind /etc /etc \
	--ro-bind /sys /sys \
	--ro-bind /run /run \
	--dev /dev \
	--proc /proc \
	--tmpfs /tmp \
	--bind "@DIR@" /data \
	--chdir /data \
	"@JAVA@/bin/java" "${JVM_ARGS[@]}" -jar minecraft_server.jar nogui
