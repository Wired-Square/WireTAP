import { useCallback, useEffect, useState } from "react";
import { api, DatabaseEntry, formatBytes } from "../api";

export default function Databases() {
  const [databases, setDatabases] = useState<DatabaseEntry[]>([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    api<{ databases: DatabaseEntry[] }>("/v1/databases")
      .then((r) => setDatabases(r.databases))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(refresh, [refresh]);

  const create = async () => {
    setCreating(true);
    setError("");
    try {
      await api("/v1/databases", { method: "POST", body: { name } });
      setName("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (dbName: string) => {
    if (
      !confirm(
        `Delete database "${dbName}"? This permanently removes all its captured ` +
          `frames and cannot be undone.`,
      )
    )
      return;
    setError("");
    try {
      await api(`/v1/databases/${dbName}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      // e.g. 409 when a device is actively ingesting into it
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: "0.75rem" }}>
        <h2 style={{ margin: 0 }}>Capture databases</h2>
        <div className="spacer" />
        <input
          placeholder="new_capture_name"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          pattern="[a-z][a-z0-9_]*"
        />
        <button className="btn primary" disabled={!name || creating} onClick={create}>
          Create
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Size</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {databases.map((d) => (
            <tr key={d.name}>
              <td className="mono">{d.name}</td>
              <td>{formatBytes(d.size_bytes)}</td>
              <td style={{ textAlign: "right" }}>
                <button className="btn danger" onClick={() => remove(d.name)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ marginBottom: 0 }}>
        Ingest devices can also auto-create a database by naming one in their
        HELLO message (when auto-create is enabled).
      </p>
    </div>
  );
}
