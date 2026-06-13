#!/usr/bin/env bash
# setup-ssh.sh — run on your Mac. Makes `ssh daybook` work exactly like
# `ssh otuburu` by cloning the existing otuburu Host block in ~/.ssh/config.
# daybook lives on the SAME server as otuburu, so host/user/key are identical.
set -euo pipefail
CFG="${HOME}/.ssh/config"

if [ ! -f "$CFG" ] || ! grep -qiE '^[[:space:]]*Host[[:space:]]+otuburu([[:space:]]|$)' "$CFG"; then
  echo "No 'Host otuburu' block found in $CFG."
  echo "Add daybook manually, e.g.:"
  cat <<'EX'

  Host daybook
      HostName <your-server-ip>
      User user1
      IdentityFile ~/.ssh/id_ed25519

EX
  exit 1
fi

if grep -qiE '^[[:space:]]*Host[[:space:]]+daybook([[:space:]]|$)' "$CFG"; then
  echo "'Host daybook' already exists in $CFG — nothing to do."
  exit 0
fi

# Extract the otuburu block (from its Host line to the next Host line / EOF),
# then rename the alias to daybook.
block="$(awk '
  BEGIN{grab=0}
  /^[[:space:]]*Host[[:space:]]/{ if(grab){exit} ; if($2=="otuburu"){grab=1} }
  { if(grab) print }
' "$CFG")"

cloned="$(printf '%s\n' "$block" | sed -E '0,/^[[:space:]]*Host[[:space:]]+otuburu/s//Host daybook/')"

printf '\n# Added by daybook setup-ssh.sh (same server as otuburu)\n%s\n' "$cloned" >> "$CFG"
echo "Added 'Host daybook' to $CFG. Test with:  ssh daybook 'echo ok'"
