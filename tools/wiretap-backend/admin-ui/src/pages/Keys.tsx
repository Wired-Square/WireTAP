import { useCallback, useEffect, useState } from "react";
import { api, KeySummary } from "../api";

export default function Keys() {
  const [keys, setKeys] = useState<KeySummary[]>([]);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("read");
  const [pin, setPin] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    api<{ keys: KeySummary[] }>("/v1/admin/keys")
      .then((r) => setKeys(r.keys))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(refresh, [refresh]);

  const create = async () => {
    setError("");
    try {
      const r = await api<{ id: number; key: string }>("/v1/admin/keys", {
        method: "POST",
        body: { name, role, database_pin: pin || null },
      });
      setCreated(r.key);
      setCopied(false);
      setName("");
      setPin("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const act = async (k: KeySummary, verb: "revoke" | "restore" | "delete") => {
    const prompts: Record<typeof verb, string> = {
      revoke: `Revoke key "${k.name}"? Clients using it lose access immediately.`,
      restore: `Restore key "${k.name}"? It will work again.`,
      delete: `Permanently delete key "${k.name}"? This cannot be undone.`,
    };
    if (!confirm(prompts[verb])) return;
    const req =
      verb === "delete"
        ? { method: "DELETE" as const }
        : { method: "POST" as const };
    const path = verb === "delete" ? `/v1/admin/keys/${k.id}` : `/v1/admin/keys/${k.id}/${verb}`;
    try {
      await api(path, req);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: "0.75rem" }}>
        <h2 style={{ margin: 0 }}>API keys</h2>
        <div className="spacer" />
        <button className="btn primary" onClick={() => { setShowCreate(!showCreate); setCreated(null); }}>
          {showCreate ? "Close" : "New key"}
        </button>
      </div>

      {showCreate && (
        <div className="card">
          <div className="row">
            <input placeholder="Name (e.g. shed-esp32)" value={name} onChange={(e) => setName(e.target.value)} />
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="read">read — desktop / queries</option>
              <option value="ingest">ingest — capture devices</option>
              <option value="admin">admin — full control</option>
            </select>
            <input
              placeholder="Database pin (optional)"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              title="Restrict this key to one capture database"
            />
            <button className="btn primary" disabled={!name} onClick={create}>
              Create
            </button>
          </div>
          {created && (
            <div className="keyreveal">
              <div className="muted" style={{ marginBottom: "0.4rem" }}>
                Copy this key now — it is shown once and never stored.
              </div>
              <span className="mono">{created}</span>{" "}
              <button
                className="btn"
                onClick={() => navigator.clipboard.writeText(created).then(() => setCopied(true))}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Database pin</th>
            <th>Last used</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td>
                <span className={`badge ${k.role}`}>{k.role}</span>
              </td>
              <td className="mono">{k.database_pin ?? "—"}</td>
              <td className="muted">
                {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
              </td>
              <td>
                <span className={`badge ${k.revoked ? "revoked" : "ok"}`}>
                  {k.revoked ? "revoked" : "active"}
                </span>
              </td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                {k.revoked ? (
                  <>
                    <button className="btn" onClick={() => act(k, "restore")}>
                      Restore
                    </button>{" "}
                    <button className="btn danger" onClick={() => act(k, "delete")}>
                      Delete
                    </button>
                  </>
                ) : (
                  <button className="btn danger" onClick={() => act(k, "revoke")}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
          {keys.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No keys yet — the WIRETAP_ADMIN_KEY environment key is the only access.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
