import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import {
  AuthUser,
  Declaration,
  DeclarationStatus,
  displayName,
  displayWallet
} from "./types";
import { connectMetaMask, formatEcoFromWei, hasMetaMask } from "./wallet";
import WeeklyChallenge from "./WeeklyChallenge";

type Screen = "login" | "register";
type AdminFilter = DeclarationStatus;

const MATERIALS = ["Plastique", "Papier", "Verre", "Métal", "Carton", "Aluminium", "Organique", "Électronique"];

function shortAddr(addr?: string | null) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function shortTx(tx?: string | null) {
  if (!tx) return null;
  return `${tx.slice(0, 10)}…${tx.slice(-6)}`;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [token, setToken] = useState(localStorage.getItem("token") || "");
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      return JSON.parse(localStorage.getItem("user") || "null");
    } catch {
      return null;
    }
  });
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Auth forms
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");

  // User declarations
  const [items, setItems] = useState<Declaration[]>([]);
  const [material, setMaterial] = useState("Plastique");
  const [quantity, setQuantity] = useState("1");
  const [description, setDescription] = useState("");
  const [ecoBalance, setEcoBalance] = useState<string | null>(null);

  // Admin
  const [adminFilter, setAdminFilter] = useState<AdminFilter>("PENDING");
  const [adminItems, setAdminItems] = useState<Declaration[]>([]);
  const [overrideEco, setOverrideEco] = useState("");
  const [overrideWhy, setOverrideWhy] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const flash = (text: string, type: "ok" | "err" = "ok") => setFeedback({ text, type });

  const persistSession = (nextToken: string, nextUser: AuthUser) => {
    localStorage.setItem("token", nextToken);
    localStorage.setItem("user", JSON.stringify(nextUser));
    setToken(nextToken);
    setUser(nextUser);
  };

  const logout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setToken("");
    setUser(null);
    setItems([]);
    setAdminItems([]);
    setEcoBalance(null);
    flash("Déconnecté.");
  };

  const handleError = (e: unknown) => {
    const msg = e instanceof ApiError || e instanceof Error ? e.message : "Erreur inattendue";
    flash(msg, "err");
  };

  const refreshMe = useCallback(async (auth = token) => {
    if (!auth) return;
    const data = await api<{ user: AuthUser }>("/auth/me", { token: auth });
    const u = data.user;
    setUser(u);
    localStorage.setItem("user", JSON.stringify(u));
    return u;
  }, [token]);

  const loadMine = useCallback(async (auth = token) => {
    if (!auth) return;
    const rows = await api<Declaration[]>("/declarations/mine", { token: auth });
    setItems(rows);
  }, [token]);

  const loadBalance = useCallback(async (wallet: string | null | undefined, auth = token) => {
    if (!auth || !wallet) {
      setEcoBalance(null);
      return;
    }
    const data = await api<{ balanceBaseUnits: string }>(`/rewards/balance/${wallet}`, { token: auth });
    setEcoBalance(data.balanceBaseUnits);
  }, [token]);

  const loadAdmin = useCallback(async (status: AdminFilter = adminFilter, auth = token) => {
    if (!auth) return;
    const rows = await api<Declaration[]>(`/declarations/admin/list?status=${status}`, { token: auth });
    setAdminItems(rows);
  }, [token, adminFilter]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const u = await refreshMe(token);
        if (u?.role === "USER") {
          await loadMine(token);
          await loadBalance(displayWallet(u), token);
        } else if (u?.role === "ADMIN") {
          await loadAdmin(adminFilter, token);
        }
      } catch (e) {
        handleError(e);
        if (e instanceof ApiError && e.status === 401) logout();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const data = await api<{ token: string; user: AuthUser }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      persistSession(data.token, data.user);
      flash(`Bienvenue ${displayName(data.user)}`);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function onRegister(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/auth/register", {
        method: "POST",
        body: JSON.stringify({ fullName, email, password })
      });
      flash("Compte créé. Vous pouvez vous connecter.");
      setScreen("login");
      setPassword("");
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function onCreateDeclaration(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/declarations", {
        method: "POST",
        token,
        body: JSON.stringify({
          material,
          quantity: Number(quantity),
          description: description || undefined
        })
      });
      flash("Déclaration créée (PENDING).");
      setDescription("");
      await loadMine();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function onConnectWallet() {
    setBusy(true);
    try {
      const address = await connectMetaMask();
      const data = await api<{ user: AuthUser }>("/auth/wallet", {
        method: "PATCH",
        token,
        body: JSON.stringify({ walletAddress: address })
      });
      setUser(data.user);
      localStorage.setItem("user", JSON.stringify(data.user));
      await loadBalance(displayWallet(data.user));
      flash(`Wallet associé : ${shortAddr(address)}`);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function adminAction(
    id: string,
    action: "reject" | "validate" | "retry" | "reconcile",
    body?: object
  ) {
    setBusy(true);
    try {
      const data = await api(`/declarations/admin/${id}/${action}`, {
        method: "POST",
        token,
        body: body ? JSON.stringify(body) : "{}"
      });
      flash(
        action === "validate" || action === "retry" || action === "reconcile"
          ? `Résultat : ${data.status || "OK"}${data.txHash ? ` · tx ${shortTx(data.txHash)}` : ""}`
          : "Déclaration refusée."
      );
      setSelectedId(null);
      setOverrideEco("");
      setOverrideWhy("");
      await loadAdmin();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  const wallet = displayWallet(user);
  const isAdmin = user?.role === "ADMIN";

  return (
    <main className="shell">
      <header>
        <div className="mark">♻</div>
        <div>
          <p className="eyebrow">HEDERA TESTNET · CHAIN ID 296</p>
          <h1>EcoChain</h1>
          <p className="sub">Plateforme de suivi et de récompense du recyclage</p>
        </div>
      </header>

      <section className="notice">
        <strong>Application de démonstration</strong>
        <span>
          Les récompenses ECO ne sont marquées APPROVED qu’après confirmation on-chain. Aucune clé privée n’est
          stockée dans le navigateur.
        </span>
      </section>

      {feedback && (
        <p className={`feedback-banner ${feedback.type === "err" ? "err" : "ok"}`} role="status">
          {feedback.text}
        </p>
      )}

      {!token || !user ? (
        <section className="panel auth">
          <div className="tabs">
            <button type="button" className={screen === "login" ? "tab active" : "tab"} onClick={() => setScreen("login")}>
              Connexion
            </button>
            <button
              type="button"
              className={screen === "register" ? "tab active" : "tab"}
              onClick={() => setScreen("register")}
            >
              Inscription
            </button>
          </div>

          {screen === "login" ? (
            <form className="form" onSubmit={onLogin}>
              <label>
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </label>
              <label>
                Mot de passe
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </label>
              <button disabled={busy}>{busy ? "…" : "Se connecter"}</button>
            </form>
          ) : (
            <form className="form" onSubmit={onRegister}>
              <label>
                Nom complet
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} />
              </label>
              <label>
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </label>
              <label>
                Mot de passe (min. 10 caractères)
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={10}
                />
              </label>
              <button disabled={busy}>{busy ? "…" : "Créer mon compte"}</button>
            </form>
          )}
        </section>
      ) : (
        <>
          <section className="panel top">
            <div>
              <h2>{isAdmin ? "Espace administrateur" : "Mon espace"}</h2>
              <p>
                {displayName(user)} · rôle <strong>{user.role}</strong>
                {wallet ? ` · ${shortAddr(wallet)}` : " · aucun wallet associé"}
              </p>
            </div>
            <button className="ghost" type="button" onClick={logout}>
              Déconnexion
            </button>
          </section>

          {!isAdmin && (
            <>
              <section className="panel">
                <div className="top">
                  <div>
                    <h2>Portefeuille & solde ECO</h2>
                    <p>Associez MetaMask (Hedera Testnet 296) pour recevoir les récompenses.</p>
                  </div>
                  <button type="button" onClick={onConnectWallet} disabled={busy || !hasMetaMask()}>
                    {hasMetaMask() ? (wallet ? "Mettre à jour MetaMask" : "Connecter MetaMask") : "MetaMask requis"}
                  </button>
                </div>
                <div className="stats">
                  <div>
                    <span className="label">Adresse</span>
                    <strong>{wallet || "Non définie"}</strong>
                  </div>
                  <div>
                    <span className="label">Solde ECO</span>
                    <strong>{formatEcoFromWei(ecoBalance)} ECO</strong>
                  </div>
                </div>
                <button
                  className="ghost"
                  type="button"
                  disabled={!wallet || busy}
                  onClick={() => loadBalance(wallet).catch(handleError)}
                >
                  Actualiser le solde
                </button>
              </section>

              <section className="panel">
                <h2>Nouvelle déclaration</h2>
                <form className="form" onSubmit={onCreateDeclaration}>
                  <div className="inline">
                    <label>
                      Matière
                      <select value={material} onChange={(e) => setMaterial(e.target.value)}>
                        {MATERIALS.map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Quantité (kg)
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                        required
                      />
                    </label>
                    <button disabled={busy}>Envoyer</button>
                  </div>
                  <label>
                    Description (optionnel)
                    <input
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      maxLength={2000}
                      placeholder="Ex. bouteilles collectées au campus"
                    />
                  </label>
                </form>
              </section>

              <section className="panel">
                <div className="top">
                  <h2>Mes déclarations</h2>
                  <button className="ghost" type="button" onClick={() => loadMine().catch(handleError)}>
                    Actualiser
                  </button>
                </div>
                {items.length === 0 ? (
                  <p>Aucune déclaration pour le moment.</p>
                ) : (
                  <div className="list">
                    {items.map((x) => (
                      <article className="item" key={x.id}>
                        <div>
                          <strong>
                            {x.material} · {x.quantity} kg
                          </strong>
                          <small>id {x.id.slice(0, 8)}…</small>
                          {x.estimated_reward_amount && (
                            <small>Estimé : {formatEcoFromWei(x.estimated_reward_amount)} ECO</small>
                          )}
                          {x.reward_amount && <small>Définitif : {formatEcoFromWei(x.reward_amount)} ECO</small>}
                          {x.tx_hash && (
                            <small>
                              Tx :{" "}
                              <a
                                href={`https://hashscan.io/testnet/transaction/${x.tx_hash}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {shortTx(x.tx_hash)}
                              </a>
                            </small>
                          )}
                          {x.last_error && <small className="err-text">{x.last_error}</small>}
                        </div>
                        <span className={`status ${x.status.toLowerCase()}`}>{x.status}</span>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <WeeklyChallenge
                token={token}
                isAdmin={false}
                busy={busy}
                setBusy={setBusy}
                flash={flash}
                handleError={handleError}
              />
            </>
          )}

          {isAdmin && (
            <>
              <section className="panel">
                <div className="top">
                  <div>
                    <h2>File des déclarations</h2>
                    <p>Valider / refuser / retry / réconcilier — sans mint fictif.</p>
                  </div>
                  <div className="admin-tools">
                    <select
                      value={adminFilter}
                      onChange={(e) => {
                        const v = e.target.value as AdminFilter;
                        setAdminFilter(v);
                        loadAdmin(v).catch(handleError);
                      }}
                    >
                      {(["PENDING", "PROCESSING", "APPROVED", "REJECTED", "FAILED"] as AdminFilter[]).map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <button className="ghost" type="button" onClick={() => loadAdmin().catch(handleError)}>
                      Actualiser
                    </button>
                  </div>
                </div>

                {adminItems.length === 0 ? (
                  <p>Aucune déclaration en statut {adminFilter}.</p>
                ) : (
                  <div className="list">
                    {adminItems.map((d) => (
                      <article className="item admin-item" key={d.id}>
                        <div>
                          <strong>
                            {d.material} · {d.quantity} kg
                          </strong>
                          <small>
                            {d.full_name || "—"} · {d.email}
                          </small>
                          <small>Wallet : {d.wallet_address || d.user_wallet_address || "—"}</small>
                          {d.estimated_reward_amount && (
                            <small>Estimé : {formatEcoFromWei(d.estimated_reward_amount)} ECO</small>
                          )}
                          {d.reward_amount && <small>Définitif : {formatEcoFromWei(d.reward_amount)} ECO</small>}
                          {d.tx_hash && <small>Tx : {shortTx(d.tx_hash)}</small>}
                          {d.last_error && <small className="err-text">{d.last_error}</small>}
                        </div>
                        <div className="admin-actions">
                          <span className={`status ${d.status.toLowerCase()}`}>{d.status}</span>
                          {d.status === "PENDING" && (
                            <>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  const body =
                                    selectedId === d.id && overrideEco
                                      ? { amountEco: overrideEco, justification: overrideWhy }
                                      : {};
                                  if (body.amountEco && (!overrideWhy || overrideWhy.trim().length < 5)) {
                                    flash("Justification obligatoire (≥5 car.) pour un override", "err");
                                    return;
                                  }
                                  adminAction(d.id, "validate", Object.keys(body).length ? body : undefined);
                                }}
                              >
                                Valider
                              </button>
                              <button
                                className="ghost danger"
                                type="button"
                                disabled={busy}
                                onClick={() => adminAction(d.id, "reject")}
                              >
                                Refuser
                              </button>
                              <button
                                className="ghost"
                                type="button"
                                onClick={() => setSelectedId(selectedId === d.id ? null : d.id)}
                              >
                                Override…
                              </button>
                            </>
                          )}
                          {d.status === "FAILED" && (
                            <button type="button" disabled={busy} onClick={() => adminAction(d.id, "retry")}>
                              Retry
                            </button>
                          )}
                          {d.status === "PROCESSING" && (
                            <button type="button" disabled={busy} onClick={() => adminAction(d.id, "reconcile")}>
                              Réconcilier
                            </button>
                          )}
                        </div>
                        {selectedId === d.id && d.status === "PENDING" && (
                          <div className="override-box">
                            <label>
                              Montant ECO override (optionnel)
                              <input
                                value={overrideEco}
                                onChange={(e) => setOverrideEco(e.target.value)}
                                placeholder="ex. 30"
                              />
                            </label>
                            <label>
                              Justification (obligatoire si override)
                              <input
                                value={overrideWhy}
                                onChange={(e) => setOverrideWhy(e.target.value)}
                                placeholder="Motif administrateur"
                              />
                            </label>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <WeeklyChallenge
                token={token}
                isAdmin
                busy={busy}
                setBusy={setBusy}
                flash={flash}
                handleError={handleError}
              />
            </>
          )}
        </>
      )}

      <footer>EcoChain · Projet académique Fatimetou & Yakin</footer>
    </main>
  );
}
