#!@BASH@/bin/bash
# Add/remove the mc (25565 accept) and rcon (25575 drop) rules in the nftables
# `inet nixos input` chain, above the default drop. systemd runs this as root
# via the `+` prefix. `just stage` fills @NFT@/@GAWK@.
set -euo pipefail
NFT="@NFT@/bin/nft"
AWK="@GAWK@/bin/awk"

has_rule() { # $1 = comment
	"$NFT" -a list chain inet nixos input | "$AWK" -v c="comment \"$1\"" 'index($0,c){f=1} END{exit !f}'
}

# add_rule <comment> <dport> <verdict>
add_rule() {
	has_rule "$1" && return 0
	local handle
	handle=$("$NFT" -a list chain inet nixos input | "$AWK" '/drop comment "default"/{print $NF}')
	[ -n "$handle" ] || {
		echo "no default-drop rule found in inet nixos input" >&2
		exit 1
	}
	"$NFT" insert rule inet nixos input handle "$handle" tcp dport "$2" "$3" comment "\"$1\""
}

del_rules() {
	local handle
	while
		handle=$("$NFT" -a list chain inet nixos input | "$AWK" -v c="comment \"$1\"" 'index($0,c){print $NF; exit}')
		[ -n "$handle" ]
	do
		"$NFT" delete rule inet nixos input handle "$handle"
	done
}

case "${1:-}" in
open)
	add_rule minecraft 25565 accept
	add_rule minecraft-rcon 25575 drop
	echo "firewall: :25565 accept, :25575 drop"
	;;
close)
	del_rules minecraft
	del_rules minecraft-rcon
	echo "firewall: removed minecraft rules"
	;;
*)
	echo "usage: $0 open|close" >&2
	exit 2
	;;
esac
