import { useCallback, useEffect, useState } from "react";
import { Activity as Row, api, DatabaseEntry } from "../api";

export default function Activity() {
  const [databases, setDatabases] = useState<string[]>([]);
  const [db, setDb] = useState("");
  const [queries, setQueries] = useState<Row[]>([]);
  const [sessions, setSessions] = useState<Row[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ databases: DatabaseEntry[] }>("/v1/databases")
      .then((r) => {
        const names = r.databases.map((d) => d.name);
        setDatabases(names);
        if (!db && names.length) setDb(names[0]);
      })
      .catch((e) => setError(String(e.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(() => {
    if (!db) return;
    api<{ queries: Row[]; sessions: Row[] }>(`/v1/db/${db}/activity`)
      .then((r) => {
        setQueries(r.queries);
        setSessions(r.sessions);
        setError("");
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [db]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const signal = async (pid: number, terminate: boolean) => {
    try {
      await api(`/v1/db/${db}/activity/${pid}${terminate ? "" : "/cancel"}`, {
        method: terminate ? "DELETE" : "POST",
      });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const table = (rows: Row[], active: boolean) => (
    <table>
      <thead>
        <tr>
          <th>PID</th>
          <th>Client</th>
          <th>Application</th>
          <th>{active ? "Query" : "State"}</th>
          <th>Duration</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.pid}>
            <td className="mono">{r.pid}</td>
            <td className="mono">{r.client_addr ?? "local"}</td>
            <td>{r.application_name || "—"}</td>
            <td className="mono" style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {active ? (r.query ?? "") : (r.state ?? "")}
            </td>
            <td className="muted">{r.duration_secs != null ? `${r.duration_secs.toFixed(1)} s` : "—"}</td>
            <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              {active && (
                <button className="btn" onClick={() => signal(r.pid, false)}>
                  Cancel
                </button>
              )}{" "}
              <button className="btn danger" onClick={() => signal(r.pid, true)}>
                Terminate
              </button>
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={6} className="muted">
              {active ? "No running queries." : "No idle sessions."}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );

  return (
    <>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Database activity</h2>
          <div className="spacer" />
          <select value={db} onChange={(e) => setDb(e.target.value)}>
            {databases.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
      <div className="card">
        <h2>Running queries</h2>
        {table(queries, true)}
      </div>
      <div className="card">
        <h2>Idle sessions</h2>
        {table(sessions, false)}
      </div>
    </>
  );
}
