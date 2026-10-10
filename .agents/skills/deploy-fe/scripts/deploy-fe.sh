#!/usr/bin/env bash
# Deploys apps/store to production on a Vercel project's *.vercel.app domain. Contract: ../SKILL.md.
set -euo pipefail

required_env=(MPP_SECRET_KEY MPP_RECIPIENT DEMO_BATCH_ID DEMO_SKU DEMO_PRICE RESLABS_LINK_ORIGIN
	RESLABS_SESSION_URL TEMPO_RPC_URL DATABASE_URL CRON_SECRET)
optional_env=(RESLABS_EDGE_KEY)
url_env=(DATABASE_URL RESLABS_LINK_ORIGIN RESLABS_SESSION_URL TEMPO_RPC_URL)
placeholder_env=(MPP_SECRET_KEY MPP_RECIPIENT DEMO_BATCH_ID)

blocked() {
	echo "result=blocked reason=$*"
	exit 2
}
fail() {
	echo "result=fail reason=$*"
	exit 1
}
usage() { blocked "usage: deploy-fe.sh --scope <team-slug> --env-file <path> [--project <name>]"; }

project=reslabs-reup-demo
scope=
env_file=
while [ $# -gt 0 ]; do
	[ $# -ge 2 ] || usage
	case $1 in
	--scope) scope=$2 ;;
	--env-file) env_file=$2 ;;
	--project) project=$2 ;;
	*) usage ;;
	esac
	shift 2
done
[ -n "$scope" ] && [ -n "$env_file" ] || usage
[ -f "$env_file" ] || blocked "env_file_not_found"
for tool in vercel jq curl git tar; do
	command -v "$tool" >/dev/null || blocked "missing_tool tool=$tool"
done
repo=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
env_file=$(cd "$(dirname "$env_file")" && pwd)/$(basename "$env_file")
case $env_file in
"$repo"/*)
	if git -C "$repo" ls-files --error-unmatch -- "$env_file" >/dev/null 2>&1 ||
		! git -C "$repo" check-ignore -q -- "$env_file"; then
		blocked "env_file_not_ignored"
	fi
	;;
esac

# Values travel only through pipes and files, never argv or stdout.
env_value() {
	local line
	line=$(grep -E "^(export[[:space:]]+)?$2=" "$1" | tail -n 1 || true)
	line=${line#*=}
	line=${line%$'\r'}
	case $line in
	\"*\" | \'*\') line=${line:1:${#line}-2} ;;
	esac
	printf '%s' "$line"
}

url_host() {
	local rest=${1#*://}
	rest=${rest%%[/?#]*}
	rest=${rest##*@}
	case $rest in
	\[*)
		rest=${rest#\[}
		rest=${rest%%]*}
		;;
	*) rest=${rest%%:*} ;;
	esac
	printf '%s' "$rest" | tr '[:upper:]' '[:lower:]'
}

is_loopback() {
	case $1 in
	"" | localhost | *.localhost | 127.* | ::1 | 0.0.0.0 | host.docker.internal) return 0 ;;
	*) return 1 ;;
	esac
}

missing=()
for name in "${required_env[@]}"; do
	[ -n "$(env_value "$env_file" "$name")" ] || missing+=("$name")
done
[ ${#missing[@]} -eq 0 ] || blocked "env_missing names=$(IFS=,; echo "${missing[*]}")"
for name in "${url_env[@]}"; do
	if is_loopback "$(url_host "$(env_value "$env_file" "$name")")"; then blocked "loopback_url name=$name"; fi
done
for name in "${placeholder_env[@]}"; do
	if [ "$(env_value "$env_file" "$name")" = "$(env_value "$repo/.env.example" "$name")" ]; then
		blocked "placeholder_value name=$name"
	fi
done
[ "$(env_value "$env_file" CRON_SECRET)" != YOUR_RANDOM_SECRET ] || blocked "placeholder_value name=CRON_SECRET"

auth_file=
for candidate in "$HOME/.vercel/auth.json" "$HOME/Library/Application Support/com.vercel.cli/auth.json" \
	"${XDG_DATA_HOME:-$HOME/.local/share}/com.vercel.cli/auth.json"; do
	if [ -f "$candidate" ]; then
		auth_file=$candidate
		break
	fi
done
[ -n "$auth_file" ] || blocked "vercel_not_logged_in"

umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
log=$tmp/vercel.log
jq -er '"Authorization: Bearer \(.token | strings)"' "$auth_file" >"$tmp/auth" 2>/dev/null ||
	blocked "vercel_not_logged_in"

fail_with_log() {
	tail -n 40 "$log" >&2
	fail "$*"
}

# Upload only what git would track: the CLI's default ignore list still uploads .env and .e2e/.
stage=$tmp/stage
mkdir "$stage"
(
	cd "$repo"
	git ls-files -z -co --exclude-standard | while IFS= read -r -d '' file; do
		if [ -e "$file" ]; then printf '%s\0' "$file"; fi
	done | tar --null -T - -cf -
) | tar -xf - -C "$stage"
echo "source=$(git -C "$repo" rev-parse HEAD) dirty=$([ -z "$(git -C "$repo" status --porcelain)" ] && echo false || echo true)"

# Linking the stage, which has no .git, keeps the CLI from connecting the project to the Git repository.
vercel link --yes --project "$project" --scope "$scope" --cwd "$stage" >>"$log" 2>&1 || fail_with_log "link_failed"
project_id=$(jq -r .projectId "$stage/.vercel/project.json")
org_id=$(jq -r .orgId "$stage/.vercel/project.json")
case $org_id in
team_*) team_query="?teamId=$org_id" ;;
*) team_query= ;;
esac
echo "project=$project project_id=$project_id org_id=$org_id"

api() {
	local path=$1
	shift
	curl -sS --fail-with-body -H @"$tmp/auth" "https://api.vercel.com$path$team_query" "$@"
}

domains=$(api "/v9/projects/$project_id/domains") || blocked "domain_lookup_failed"
custom=$(jq -r '[.domains[].name | select(endswith(".vercel.app") | not)] | join(",")' <<<"$domains")
[ -z "$custom" ] || blocked "custom_domain domains=$custom"
production_host=$(jq -r '[.domains[] | select(.redirect == null) | .name][0] // empty' <<<"$domains")
[ -n "$production_host" ] || blocked "no_vercel_app_domain"

settings=$(api "/v9/projects/$project_id" -X PATCH -H 'Content-Type: application/json' \
	-d '{"framework":"nextjs","rootDirectory":"apps/store","sourceFilesOutsideRootDirectory":true}') ||
	fail "settings_update_failed body=$(jq -c . <<<"$settings" 2>/dev/null || echo unparsable)"
echo "settings=$(jq -c '{framework, rootDirectory, sourceFilesOutsideRootDirectory, nodeVersion}' <<<"$settings")"

sync_env() {
	printf '%s' "$2" | vercel env add "$1" production --force --cwd "$stage" --scope "$scope" >>"$log" 2>&1 ||
		fail_with_log "env_sync_failed name=$1"
	echo "env=$1 synced"
}
for name in "${required_env[@]}"; do
	sync_env "$name" "$(env_value "$env_file" "$name")"
done
for name in "${optional_env[@]}"; do
	value=$(env_value "$env_file" "$name")
	if [ -n "$value" ]; then sync_env "$name" "$value"; fi
done
unset value
# Vercel only knows pnpm up to 10. Corepack installs the version pinned in package.json#packageManager.
sync_env ENABLE_EXPERIMENTAL_COREPACK 1

deployed=true
deployment_url=$(vercel deploy --prod --yes --cwd "$stage" --scope "$scope" 2>>"$log" | tail -n 1) || deployed=false
if [ -n "$deployment_url" ]; then echo "deployment_url=$deployment_url"; fi
[ "$deployed" = true ] && [ -n "$deployment_url" ] || fail_with_log "deploy_failed"

state=$(api "/v13/deployments/${deployment_url#https://}" | jq -r '"\(.readyState) \(.target)"') ||
	fail "deployment_lookup_failed"
[ "$state" = "READY production" ] || fail "deployment_not_ready state=${state// /,}"
echo "state=READY target=production"
echo "production_url=https://$production_host custom_domains=none"

base=https://$production_host
probes_failed=0
http_status() { curl -sS -o "$tmp/body" -w '%{http_code}' --max-time 60 "$@" || true; }
check() {
	if [ "$3" = "$2" ]; then
		echo "probe=\"$1\" got=\"$3\" result=pass"
	else
		echo "probe=\"$1\" got=\"$3\" want=\"$2\" result=fail"
		probes_failed=1
	fi
}
check "GET /" 200 "$(http_status "$base/")"
check "GET /orders" 200 "$(http_status "$base/orders")"
verify_status=$(http_status -X POST -H 'Content-Type: application/json' \
	-d '{"link":"https://example.invalid/v/p?t=probe"}' "$base/api/verify")
check "POST /api/verify foreign link" "400 bad_link" "$verify_status $(jq -r '.error // empty' "$tmp/body" 2>/dev/null)"
check "GET /api/cron/reconcile without auth" 401 "$(http_status "$base/api/cron/reconcile")"
printf 'Authorization: Bearer %s\n' "$(env_value "$env_file" CRON_SECRET)" >"$tmp/cron"
check "GET /api/cron/reconcile with CRON_SECRET" 200 "$(http_status -H @"$tmp/cron" "$base/api/cron/reconcile")"

[ "$probes_failed" -eq 0 ] || fail "probe_failed"
echo "result=pass"
