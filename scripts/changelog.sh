#!/bin/sh
#
# Keeps CHANGELOG.md (https://keepachangelog.com/en/1.1.0/) in step with the
# commit history: every commit is listed under "## [Unreleased]" with its short
# hash, in one of Keep a Changelog's sections: Added, Changed, Deprecated,
# Removed, Fixed, Security.
#
# The section comes from the commit subject. An explicit type wins, otherwise
# the first verb decides (Add -> Added, Fix -> Fixed, Remove -> Removed, ...):
#
#   Fixed: Stop the router dropping usage on cancelled streams   -> Fixed
#   Add a /v1/models endpoint                                    -> Added
#   Breaking: Rename the coder model ids                         -> Changed, flagged
#   Breaking: Remove the HS256 dev key                           -> Removed, flagged
#
# Keep a Changelog has no "Breaking" section: a breaking change is flagged as
# "**Breaking:**" inside Changed or Removed, and means a major version bump.
#
#   scripts/changelog.sh sync          add an entry for every commit not listed yet
#   scripts/changelog.sh add <rev>     add one commit (post-commit hook)
#   scripts/changelog.sh check         fail if a commit is missing or the format is off
#   scripts/changelog.sh check --index check the staged CHANGELOG.md (pre-commit hook)
#   scripts/changelog.sh rewrite       read "old new" hash pairs on stdin (post-rewrite hook)
#
# A commit cannot contain its own hash, so an entry is written right after its
# commit (post-commit) and goes in with the next one (pre-commit stages it).
# Entries are a starting point: reword them, move them between sections, or cut
# a release by renaming "[Unreleased]" to "[x.y.z] - YYYY-MM-DD" and adding a
# fresh "[Unreleased]" above it. Only the short hash has to stay.
#
# Merge commits, and commits that only touch CHANGELOG.md, are not listed.

set -e

root=$(git rev-parse --show-toplevel)
file="$root/CHANGELOG.md"
short=7

sections='Added Changed Deprecated Removed Fixed Security'

section_for() {
	case "$1" in
	Add* | Introduce* | Create* | Support* | Document*) echo Added ;;
	Fix* | Correct* | Repair* | Restore*) echo Fixed ;;
	Remove* | Delete* | Drop*) echo Removed ;;
	Deprecate*) echo Deprecated ;;
	Secur*) echo Security ;;
	*) echo Changed ;;
	esac
}

# Commits worth listing, oldest first.
commits() {
	git rev-list --reverse --no-merges HEAD 2>/dev/null | while read -r sha; do
		only=$(git diff-tree --root --no-commit-id --name-only -r "$sha")
		[ "$only" = "CHANGELOG.md" ] && continue
		git rev-parse --short=$short "$sha"
	done
}

listed() {
	grep -q "\`$1\`" "$file"
}

# Insert one entry under [Unreleased], in its section, keeping sections in
# Keep a Changelog order and everything outside [Unreleased] untouched.
insert() {
	sec=$1
	entry=$2
	tmp=$(mktemp)
	awk -v sec="$sec" -v entry="$entry" -v order="$sections" '
		function flush(   i, n, names, s) {
			n = split(order, names, " ")
			print "## [Unreleased]"
			print ""
			if (intro != "") { printf "%s", intro; print "" }
			for (i = 1; i <= n; i++) {
				s = names[i]
				if (body[s] == "") continue
				print "### " s
				print ""
				printf "%s", body[s]
				print ""
			}
			for (s in body) if (index(" " order " ", " " s " ") == 0 && body[s] != "") {
				print "### " s; print ""; printf "%s", body[s]; print ""
			}
		}
		BEGIN { state = "before" }
		state == "before" && /^## \[Unreleased\]/ { state = "in"; cur = ""; next }
		state == "in" && (/^## \[/ || /^\[[^]]+\]: /) {
			body[sec] = body[sec] entry "\n"; flush(); state = "after"; print; next
		}
		state == "in" && /^### / { cur = substr($0, 5); next }
		state == "in" {
			if ($0 ~ /^[[:space:]]*$/) next
			if (cur == "") intro = intro $0 "\n"; else body[cur] = body[cur] $0 "\n"
			next
		}
		{ print }
		END {
			if (state == "in") { body[sec] = body[sec] entry "\n"; flush() }
			if (state == "before") exit 3
		}
	' "$file" >"$tmp" || {
		rm -f "$tmp"
		echo "CHANGELOG.md has no \"## [Unreleased]\" section." >&2
		exit 1
	}
	mv "$tmp" "$file"
}

# Prints the section the entry went to ("Fixed", "Changed (breaking)"), or
# nothing when the commit is skipped or already listed.
add() {
	sha=$(git rev-parse --short=$short "$1")
	listed "$sha" && return 0
	only=$(git diff-tree --root --no-commit-id --name-only -r "$sha")
	[ "$only" = "CHANGELOG.md" ] && return 0
	[ "$(git rev-list --no-walk --count --min-parents=2 "$sha")" = 0 ] || return 0
	# Drop a leading emoji or symbol; the rest of the subject is the entry.
	subject=$(git log -1 --format=%s "$sha" | LC_ALL=C sed 's/^[^A-Za-z0-9]*//')
	flag=""
	case "$subject" in
	[Bb]reaking:* | BREAKING:*)
		subject=$(printf '%s' "${subject#*:}" | sed 's/^ *//')
		flag="**Breaking:** "
		;;
	esac
	sec=""
	for t in $sections; do
		case "$subject" in
		"$t":*)
			sec=$t
			subject=$(printf '%s' "${subject#*:}" | sed 's/^ *//')
			;;
		esac
	done
	[ -n "$sec" ] || sec=$(section_for "$subject")
	# A breaking change is a change or a removal, never a plain addition or fix.
	if [ -n "$flag" ] && [ "$sec" != Removed ]; then sec=Changed; fi
	insert "$sec" "- $flag$subject (\`$sha\`)"
	printf '%s%s\n' "$sec" "${flag:+ (breaking)}"
}

sync() {
	commits | while read -r sha; do add "$sha" >/dev/null; done
}

check() {
	if [ "$1" = "--index" ]; then
		src=$(mktemp)
		git show :CHANGELOG.md >"$src" 2>/dev/null || {
			echo "CHANGELOG.md is not staged." >&2
			rm -f "$src"
			exit 1
		}
	else
		src=$file
	fi
	problems=""
	head -1 "$src" | grep -qx '# Changelog' || problems="$problems\n  first line must be \"# Changelog\""
	grep -q 'keepachangelog.com/en/1.1.0' "$src" || problems="$problems\n  must link https://keepachangelog.com/en/1.1.0/"
	grep -qx '## \[Unreleased\]' "$src" || problems="$problems\n  needs a \"## [Unreleased]\" section"
	bad=$(grep '^## ' "$src" | grep -Ev '^## \[Unreleased\]$|^## \[[0-9]+\.[0-9]+\.[0-9]+[^]]*\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$' || true)
	[ -z "$bad" ] || problems="$problems\n  version headings must be \"## [x.y.z] - YYYY-MM-DD\": $bad"
	badsec=$(grep '^### ' "$src" | grep -Ev '^### (Added|Changed|Deprecated|Removed|Fixed|Security)$' || true)
	[ -z "$badsec" ] || problems="$problems\n  sections must be Added, Changed, Deprecated, Removed, Fixed or Security: $badsec"
	missing=$(commits | while read -r sha; do grep -q "\`$sha\`" "$src" || printf ' %s' "$sha"; done)
	[ -z "$missing" ] || problems="$problems\n  commits not listed:$missing (run scripts/changelog.sh sync)"
	[ "$src" = "$file" ] || rm -f "$src"
	if [ -n "$problems" ]; then
		printf 'CHANGELOG.md:%b\n' "$problems" >&2
		exit 1
	fi
}

# After an amend or rebase, point entries at the new hashes. If the new hash is
# already listed (post-commit ran first), drop the stale line instead.
rewrite() {
	[ -f "$file" ] || return 0
	while read -r old new _; do
		o=$(printf '%s' "$old" | cut -c1-$short)
		n=$(git rev-parse --short=$short "$new")
		grep -q "\`$o\`" "$file" || continue
		tmp=$(mktemp)
		if listed "$n"; then
			grep -v "\`$o\`" "$file" >"$tmp"
		else
			sed "s/\`$o\`/\`$n\`/" "$file" >"$tmp"
		fi
		mv "$tmp" "$file"
	done
}

case "$1" in
sync) sync ;;
add) add "${2:?usage: changelog.sh add <rev>}" ;;
check) check "$2" ;;
rewrite) rewrite ;;
*)
	sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
