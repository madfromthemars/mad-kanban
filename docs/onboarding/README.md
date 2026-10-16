# Onboarding guide

**Current guide:** `setup-guide.html` → *Mad Kanban - Setup Guide.pdf*: computer and phone from scratch
(Obsidian, BRAT install of `madfromthemars/mad-kanban`, join link, QR sign-in for phones, usage,
devices, troubleshooting). Print it the same way as below. `guide.html` (zip-vault flow) and
`phone-guide.html` are older, narrower guides.

`Mad Kanban - Getting Started.pdf` is the guide sent to new people, together with the
personal join link a host copies from **Manage team → Add person**. The PDF has no link
or token in it, so the same file works for everyone.

The guide sends people to a ready-made vault with the plugin installed:
`http://170.168.60.196:8787/download/mad-kanban-vault.zip`. That zip lives in
`server/public/` on the server (not in git).

## Updating the PDF

Edit `guide.html`, then print it with Chrome:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --no-pdf-header-footer --print-to-pdf="docs/onboarding/Mad Kanban - Getting Started.pdf" \
  "file://$PWD/docs/onboarding/guide.html"
```

Screenshots in `img/` are 1400×850 captures of the plugin; `guide.html` crops and scales them.

## Rebuilding the vault zip

After a release, so new people start on the latest version (they auto-update anyway):

```sh
rm -rf /tmp/vz && mkdir -p "/tmp/vz/Mad Kanban/.obsidian/plugins/kanban-custom"
cp manifest.json main.js styles.css "/tmp/vz/Mad Kanban/.obsidian/plugins/kanban-custom/"
echo '["kanban-custom"]' > "/tmp/vz/Mad Kanban/.obsidian/community-plugins.json"
(cd /tmp/vz && rm -f "$OLDPWD/server/public/mad-kanban-vault.zip" && COPYFILE_DISABLE=1 zip -qr -X "$OLDPWD/server/public/mad-kanban-vault.zip" "Mad Kanban")
scp server/public/mad-kanban-vault.zip abdulaziz_pensiya@170.168.60.196:kanban-server/public/
```
