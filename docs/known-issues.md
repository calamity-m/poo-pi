# Known Issues

## Proxy upstream error after `/reload`

Status: fixed in `extensions/core/extensions/proxy/routes.ts` by stale-port route recovery.

Observed symptom: after `/reload`, model requests sometimes returned `proxy: upstream error`.

Likely cause: `/reload` can restart the ephemeral loopback proxy on a new port while the model registry still contains base URLs pointing at the old proxy port. If route recovery treats that stale local proxy URL as the real upstream, the new proxy forwards to a dead old proxy and returns an upstream error.

Reference check: run `npm run smoke:proxy-reload` to verify stale `127.0.0.1:<old-port>/p/<route>` URLs unwrap back to the original provider upstream.

If it comes back:

- Check `/proxy-audit status` for routes whose upstream is another `http://127.0.0.1:<port>/p/...` URL.
- Check `/proxy-audit recent` for upstream errors targeting loopback proxy URLs.
- Fully restart Pi once if the current process was already poisoned before the fix, because the true upstream may already have been lost from process memory.
