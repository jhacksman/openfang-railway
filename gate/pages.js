const STYLE = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  input, textarea, button { font: inherit; }
  input[type=password], textarea { width: 100%; box-sizing: border-box; padding: .5rem; }
  textarea { min-height: 20rem; font-family: ui-monospace, monospace; }
  button { padding: .5rem 1rem; margin-top: .75rem; }
  .err { color: #b00020; }
  .ok { color: #1b7f3a; }
  code, pre { font-family: ui-monospace, monospace; }
  pre { white-space: pre-wrap; background: rgba(127,127,127,.12); padding: .75rem; overflow: auto; }
`;

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>${body}</body></html>`;
}

export function loginPage({ next = "/", error = "" } = {}) {
  return page(
    "OpenFang — sign in",
    `<h1>OpenFang</h1>
<p>Enter the <code>ADMIN_PASSWORD</code> set in this service's Railway variables.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/_gate/login">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <label>Password<br><input type="password" name="password" autocomplete="current-password" autofocus required></label>
  <button type="submit">Sign in</button>
</form>`,
  );
}

export function configPage({ content, error = "", saved = false, daemonBlocked = null }) {
  return page(
    "OpenFang — config.toml",
    `<h1>config.toml</h1>
<p><a href="/">Dashboard</a> · <a href="/_gate/status">Status</a> · <form method="post" action="/_gate/logout" style="display:inline"><button type="submit">Sign out</button></form></p>
${daemonBlocked ? `<p class="err">OpenFang is not running: ${escapeHtml(daemonBlocked)}</p>` : ""}
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
${saved ? `<p class="ok">Saved. OpenFang is restarting with the new configuration.</p>` : ""}
<p>The file is validated with OpenFang's own parser before it is written. A timestamped backup of the previous
version is kept in <code>.openfang-railway/backups/</code> on the volume.</p>
<form method="post" action="/_gate/config">
  <textarea name="content" spellcheck="false">${escapeHtml(content)}</textarea>
  <button type="submit">Validate, back up and save</button>
</form>`,
  );
}

export function statusPage(status) {
  return page(
    "OpenFang — status",
    `<h1>Status</h1>
<p><a href="/">Dashboard</a> · <a href="/_gate/config">config.toml</a> · <form method="post" action="/_gate/logout" style="display:inline"><button type="submit">Sign out</button></form></p>
<pre>${escapeHtml(JSON.stringify(status, null, 2))}</pre>`,
  );
}

export function unavailablePage(detail) {
  return page(
    "OpenFang — unavailable",
    `<h1>OpenFang is not available yet</h1>
<p>${escapeHtml(detail)}</p>
<p>Signed-in administrators can inspect <a href="/_gate/status">status</a> or repair <a href="/_gate/config">config.toml</a>.</p>`,
  );
}
