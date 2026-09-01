/**
 * Pantalla de consentimiento y login.
 *
 * Muestra siempre qué cliente pide acceso y a qué URL va a redirigir. Es la
 * defensa práctica contra el punto débil del registro dinámico: cualquiera puede
 * registrar un cliente, así que la última verificación la haces tú al ver a dónde
 * te están mandando antes de escribir la clave.
 */

export interface ConsentParams {
  clientName: string;
  redirectUri: string;
  /** Campos ocultos que hay que devolver intactos al hacer POST. */
  hidden: Record<string, string>;
  error?: string;
}

export function renderConsentPage(params: ConsentParams): string {
  const hiddenFields = Object.entries(params.hidden)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n      ');

  const errorBlock = params.error ? `<p class="error" role="alert">${escapeHtml(params.error)}</p>` : '';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Autorizar acceso · SoloTodo MCP</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#16181d; --muted:#5b6472;
          --border:#dfe3e8; --accent:#c8452b; --err-bg:#fdecea; --err-fg:#8c1d12; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --card:#1c1f25; --fg:#eceef2; --muted:#9aa4b2;
            --border:#2c313a; --accent:#e2674c; --err-bg:#3a1d18; --err-fg:#f5b5a7; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
         background:var(--bg); color:var(--fg);
         font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .card { width:100%; max-width:420px; background:var(--card); border:1px solid var(--border);
          border-radius:12px; padding:28px; }
  h1 { margin:0 0 4px; font-size:19px; }
  .sub { margin:0 0 22px; color:var(--muted); font-size:14px; }
  .detail { border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:20px; font-size:14px; }
  .row { display:flex; gap:12px; padding:3px 0; }
  .row dt { flex:0 0 74px; color:var(--muted); margin:0; }
  .row dd { margin:0; word-break:break-all; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  label { display:block; font-weight:600; margin-bottom:6px; font-size:14px; }
  input[type=password] { width:100%; padding:10px 12px; font-size:15px; border-radius:8px;
                         border:1px solid var(--border); background:var(--bg); color:var(--fg); }
  input[type=password]:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { width:100%; margin-top:16px; padding:11px; font-size:15px; font-weight:600;
           color:#fff; background:var(--accent); border:0; border-radius:8px; cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  .error { background:var(--err-bg); color:var(--err-fg); padding:10px 12px;
           border-radius:8px; margin:0 0 16px; font-size:14px; }
  .foot { margin:18px 0 0; color:var(--muted); font-size:12.5px; }
</style>
</head>
<body>
  <main class="card">
    <h1>Autorizar acceso</h1>
    <p class="sub">Una aplicación quiere consultar tu servidor SoloTodo MCP.</p>

    ${errorBlock}

    <dl class="detail">
      <div class="row"><dt>Aplicación</dt><dd>${escapeHtml(params.clientName)}</dd></div>
      <div class="row"><dt>Redirige a</dt><dd>${escapeHtml(params.redirectUri)}</dd></div>
    </dl>

    <form method="post" autocomplete="off">
      ${hiddenFields}
      <label for="password">Clave maestra</label>
      <input type="password" id="password" name="password" required autofocus
             autocomplete="current-password" spellcheck="false">
      <button type="submit">Autorizar</button>
    </form>

    <p class="foot">Si no reconoces la aplicación o la URL de redirección, cierra esta página sin escribir la clave.</p>
  </main>
</body>
</html>`;
}

export function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · SoloTodo MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
         font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:420px; }
  h1 { font-size:19px; margin:0 0 8px; }
  p { color:#5b6472; margin:0; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
