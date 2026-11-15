const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem}
h1{font-size:1.3rem}.warn{background:#fff4e5;border:1px solid #f0b060;padding:.75rem;border-radius:.4rem}
.err{color:#b00020}code{background:#eee;padding:0 .25rem}input[type=password]{width:100%;padding:.5rem;margin:.5rem 0}
button{padding:.5rem 1rem;margin-right:.5rem}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function renderError(message: string): string {
  return page(
    'TaskFerry sign-in',
    `<h1>TaskFerry sign-in</h1><p class="err">${escapeHtml(message)}</p>`,
  );
}

export type ConsentView = {
  clientName: string;
  // For a Client ID Metadata Document, the hostname that published it. Shown so a self-chosen
  // display name cannot hide where the client actually comes from.
  clientIdHost?: string;
  // Where the code will be sent. Shown in full so the owner can see who really receives it.
  redirectHost: string;
  requestId: string;
  error?: string;
};

// The owner's approval page. It says plainly how much a grant is worth, because the scope is the
// whole tool surface: dispatching work, applying changes, and reading any file the service can.
export function renderConsent(view: ConsentView): string {
  const error = view.error ? `<p class="err">${escapeHtml(view.error)}</p>` : '';
  return page(
    'Approve access to TaskFerry',
    `<h1>Approve access to TaskFerry</h1>
<p><strong>${escapeHtml(view.clientName)}</strong> wants to connect.${
      view.clientIdHost
        ? ` It identifies itself as <code>${escapeHtml(view.clientIdHost)}</code>.`
        : ''
    } After you approve, it is sent to <code>${escapeHtml(view.redirectHost)}</code>.</p>
<p class="warn">Approving gives this client the same access as the bridge token: it can queue and cancel
tasks, apply or reject their changes, and read any file this service can read. Approve only a client
you started yourself, just now.</p>
${error}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request_id" value="${escapeHtml(view.requestId)}">
<label>Approval secret<input type="password" name="secret" autocomplete="off" required></label>
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</form>`,
  );
}
