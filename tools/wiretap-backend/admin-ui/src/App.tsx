import { useState } from "react";
import { api, clearKey, getKey, setKey } from "./api";
import Activity from "./pages/Activity";
import Databases from "./pages/Databases";
import Health from "./pages/Health";
import Ingest from "./pages/Ingest";
import Keys from "./pages/Keys";

const TABS = ["Keys", "Databases", "Ingest", "Activity", "Health"] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [authed, setAuthed] = useState(() => getKey() !== null);
  const [tab, setTab] = useState<Tab>("Keys");

  if (!authed) {
    return <Login onAuthed={() => setAuthed(true)} />;
  }

  return (
    <>
      <div className="topbar">
        <h1>
          Wire<span>TAP</span> Backend
        </h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <button
          className="btn"
          onClick={() => {
            clearKey();
            setAuthed(false);
          }}
        >
          Sign out
        </button>
      </div>
      {tab === "Keys" && <Keys />}
      {tab === "Databases" && <Databases />}
      {tab === "Ingest" && <Ingest />}
      {tab === "Activity" && <Activity />}
      {tab === "Health" && <Health />}
    </>
  );
}

function Login({ onAuthed }: { onAuthed: () => void }) {
  const [key, setKeyInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    setKey(key.trim());
    try {
      await api("/v1/admin/keys"); // cheapest admin-role check
      onAuthed();
    } catch (e) {
      clearKey();
      setError(e instanceof Error ? e.message : "login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <h1>
        Wire<span>TAP</span> Backend
      </h1>
      <p className="muted">Paste an admin API key to continue.</p>
      <input
        type="password"
        placeholder="Admin API key"
        value={key}
        autoFocus
        onChange={(e) => setKeyInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && key && submit()}
      />
      {error && <p className="error">{error}</p>}
      <button className="btn primary" disabled={!key || busy} onClick={submit}>
        Sign in
      </button>
    </div>
  );
}
