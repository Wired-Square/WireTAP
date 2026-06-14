import { useEffect, useState } from "react";
import { api, IngestSession } from "../api";

export default function Ingest() {
  const [sessions, setSessions] = useState<IngestSession[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    const tick = () =>
      api<{ sessions: IngestSession[] }>("/v1/admin/ingest-sessions")
        .then((r) => live && setSessions(r.sessions))
        .catch((e) => live && setError(String(e.message ?? e)));
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="card">
      <h2>Connected ingest devices</h2>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Peer</th>
            <th>Key</th>
            <th>Database</th>
            <th>Frames</th>
            <th>Batches</th>
            <th>Queue</th>
            <th>Connected</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={`${s.peer}-${s.connected_at}`}>
              <td className="mono">{s.peer}</td>
              <td>{s.key_name}</td>
              <td className="mono">{s.database}</td>
              <td>{s.frames.toLocaleString()}</td>
              <td>{s.batches.toLocaleString()}</td>
              <td>{s.queue_pct}%</td>
              <td className="muted">{new Date(s.connected_at).toLocaleTimeString()}</td>
            </tr>
          ))}
          {sessions.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No ingest devices connected. (Refreshes every 2 s.)
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
