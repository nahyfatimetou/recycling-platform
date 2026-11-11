import { FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "./api";
import {
  AdminChallengeDetail,
  AdminChallengeSummary,
  ChallengeHistoryItem,
  ChallengeSubmission,
  CurrentChallengeView,
  UserBadge
} from "./types";

type Props = {
  token: string;
  isAdmin: boolean;
  busy: boolean;
  setBusy: (v: boolean) => void;
  flash: (text: string, type?: "ok" | "err") => void;
  handleError: (e: unknown) => void;
};

type EditTaskDraft = {
  dayOfWeek: number;
  dayLabel: string;
  title: string;
  description: string;
  rewardEco: string;
};

const DAY_LABELS: Record<number, string> = {
  1: "Lundi",
  2: "Mardi",
  3: "Mercredi",
  4: "Jeudi",
  5: "Vendredi",
  6: "Samedi",
  7: "Dimanche"
};

function statusClass(status: string) {
  const s = status.toLowerCase();
  if (s === "completed" || s === "granted") return "approved";
  if (s === "failed" || s === "rejected") return "failed";
  if (s === "processing" || s === "submitted") return "processing";
  if (s === "in_progress") return "pending";
  return "pending";
}

export default function WeeklyChallenge({ token, isAdmin, busy, setBusy, flash, handleError }: Props) {
  const [current, setCurrent] = useState<CurrentChallengeView | null>(null);
  const [history, setHistory] = useState<ChallengeHistoryItem[]>([]);
  const [badges, setBadges] = useState<UserBadge[]>([]);
  const [motivation, setMotivation] = useState<string | null>(null);

  const [adminChallenges, setAdminChallenges] = useState<AdminChallengeSummary[]>([]);
  const [submissions, setSubmissions] = useState<ChallengeSubmission[]>([]);
  const [submissionFilter, setSubmissionFilter] = useState("SUBMITTED");
  const [progressRows, setProgressRows] = useState<any[]>([]);
  const [selectedChallengeId, setSelectedChallengeId] = useState<string>("");
  const [newTitle, setNewTitle] = useState("Défi écologique de la semaine");
  const [newBonus, setNewBonus] = useState("10");

  const [editId, setEditId] = useState<string>("");
  const [editTitle, setEditTitle] = useState("");
  const [editBonus, setEditBonus] = useState("10");
  const [editActive, setEditActive] = useState(true);
  const [editTasks, setEditTasks] = useState<EditTaskDraft[]>([]);

  const loadUser = useCallback(async () => {
    const [cur, hist, badgeRows] = await Promise.all([
      api<CurrentChallengeView>("/challenges/current", { token }),
      api<ChallengeHistoryItem[]>("/challenges/mine/history", { token }),
      api<UserBadge[]>("/challenges/mine/badges", { token })
    ]);
    setCurrent(cur);
    setHistory(hist);
    setBadges(badgeRows);
    if (cur.messages?.weekComplete) setMotivation(cur.messages.weekComplete);
  }, [token]);

  const loadAdmin = useCallback(async () => {
    const list = await api<AdminChallengeSummary[]>("/challenges/admin/list", { token });
    setAdminChallenges(list);
    const subs = await api<ChallengeSubmission[]>(
      `/challenges/admin/submissions/list?status=${submissionFilter}`,
      { token }
    );
    setSubmissions(subs);
    const active = list.find((c) => c.is_active) || list[0];
    if (active) {
      setSelectedChallengeId(active.id);
      const prog = await api<any[]>(`/challenges/admin/${active.id}/progress`, { token });
      setProgressRows(prog);
    }
  }, [token, submissionFilter]);

  useEffect(() => {
    (async () => {
      try {
        if (isAdmin) await loadAdmin();
        else await loadUser();
      } catch (e) {
        handleError(e);
      }
    })();
  }, [isAdmin, loadAdmin, loadUser, handleError]);

  async function onStart(progressId: string) {
    setBusy(true);
    try {
      await api(`/challenges/tasks/${progressId}/start`, { method: "POST", token });
      flash("Tâche démarrée — statut En cours");
      await loadUser();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function onComplete(progressId: string) {
    setBusy(true);
    try {
      const res = await api<{ motivation?: string; note?: string }>(`/challenges/tasks/${progressId}/complete`, {
        method: "POST",
        token
      });
      setMotivation(res.motivation || "Beau geste écologique !");
      flash(res.note || "Tâche soumise pour validation admin");
      await loadUser();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function onCreateChallenge(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/challenges/admin", {
        method: "POST",
        token,
        body: JSON.stringify({ title: newTitle, bonusEco: newBonus, isActive: true })
      });
      flash("Défi hebdomadaire créé (7 tâches par défaut)");
      await loadAdmin();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function loadEditForm(id: string) {
    const detail = await api<AdminChallengeDetail>(`/challenges/admin/${id}`, { token });
    setEditId(detail.id);
    setEditTitle(detail.title);
    setEditBonus(detail.bonus_reward_eco || "10");
    setEditActive(Boolean(detail.is_active));
    setEditTasks(
      (detail.tasks || [])
        .slice()
        .sort((a, b) => a.day_of_week - b.day_of_week)
        .map((t) => ({
          dayOfWeek: t.day_of_week,
          dayLabel: t.day_label || DAY_LABELS[t.day_of_week] || `Jour ${t.day_of_week}`,
          title: t.title,
          description: t.description || "",
          rewardEco: t.reward_eco
        }))
    );
    setSelectedChallengeId(id);
    const prog = await api<any[]>(`/challenges/admin/${id}/progress`, { token });
    setProgressRows(prog);
  }

  async function openEdit(id: string) {
    setBusy(true);
    try {
      await loadEditForm(id);
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  function updateEditTask(dayOfWeek: number, patch: Partial<EditTaskDraft>) {
    setEditTasks((prev) => prev.map((t) => (t.dayOfWeek === dayOfWeek ? { ...t, ...patch } : t)));
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editId || editTasks.length !== 7) {
      flash("Le défi doit contenir exactement 7 tâches", "err");
      return;
    }
    setBusy(true);
    try {
      await api(`/challenges/admin/${editId}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({
          title: editTitle,
          bonusEco: editBonus,
          isActive: editActive,
          tasks: editTasks.map((t) => ({
            dayOfWeek: t.dayOfWeek,
            title: t.title,
            description: t.description || undefined,
            rewardEco: t.rewardEco
          }))
        })
      });
      flash("Défi mis à jour");
      await loadAdmin();
      await loadEditForm(editId);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function adminTaskAction(id: string, action: "validate" | "reject" | "retry" | "reconcile") {
    setBusy(true);
    try {
      await api(`/challenges/admin/tasks/${id}/${action}`, { method: "POST", token });
      flash(`Action ${action} effectuée`);
      await loadAdmin();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function adminBonusAction(enrollmentId: string, action: "validate-bonus" | "retry-bonus" | "reconcile-bonus") {
    setBusy(true);
    try {
      await api(`/challenges/admin/enrollments/${enrollmentId}/${action}`, { method: "POST", token });
      flash(`Bonus: ${action}`);
      await loadAdmin();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function loadProgressFor(id: string) {
    setSelectedChallengeId(id);
    setBusy(true);
    try {
      const prog = await api<any[]>(`/challenges/admin/${id}/progress`, { token });
      setProgressRows(prog);
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  if (isAdmin) {
    return (
      <>
        <section className="panel">
          <h2>Défi écologique hebdomadaire</h2>
          <p>Créez le planning de 7 jours, définissez les récompenses, validez les soumissions avant tout mint ECO.</p>
          <form className="form inline" onSubmit={onCreateChallenge}>
            <label>
              Titre
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} required minLength={3} />
            </label>
            <label>
              Bonus semaine (ECO)
              <input value={newBonus} onChange={(e) => setNewBonus(e.target.value)} required />
            </label>
            <button disabled={busy}>Créer le défi</button>
          </form>
        </section>

        <section className="panel">
          <div className="top">
            <h2>Défis créés</h2>
            <button className="ghost" type="button" onClick={() => loadAdmin().catch(handleError)}>
              Actualiser
            </button>
          </div>
          {adminChallenges.length === 0 ? (
            <p>Aucun défi pour le moment.</p>
          ) : (
            <div className="list">
              {adminChallenges.map((c) => (
                <article className="item" key={c.id}>
                  <div>
                    <strong>{c.title}</strong>
                    <small>
                      {String(c.week_start).slice(0, 10)} → {String(c.week_end).slice(0, 10)} · bonus{" "}
                      {c.bonus_reward_eco || "?"} ECO · {c.enrollment_count || 0} inscrits
                    </small>
                  </div>
                  <div className="admin-actions">
                    <span className={`status ${c.is_active ? "approved" : "pending"}`}>
                      {c.is_active ? "ACTIF" : "INACTIF"}
                    </span>
                    <button className="ghost" type="button" disabled={busy} onClick={() => openEdit(c.id)}>
                      Modifier
                    </button>
                    <button className="ghost" type="button" onClick={() => loadProgressFor(c.id)}>
                      Progression
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {editId && editTasks.length === 7 && (
          <section className="panel">
            <h2>Modifier le défi</h2>
            <p>Ajustez le titre, le bonus et les 7 tâches quotidiennes. Aucun mint n’est déclenché ici.</p>
            <form className="form challenge-edit-form" onSubmit={onSaveEdit}>
              <label>
                Titre
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} required minLength={3} />
              </label>
              <label>
                Bonus semaine (ECO)
                <input value={editBonus} onChange={(e) => setEditBonus(e.target.value)} required />
              </label>
              <label>
                Statut
                <select
                  value={editActive ? "active" : "inactive"}
                  onChange={(e) => setEditActive(e.target.value === "active")}
                >
                  <option value="active">Actif</option>
                  <option value="inactive">Inactif</option>
                </select>
              </label>

              <div className="task-edit-grid">
                {editTasks.map((t) => (
                  <div className="task-edit-row" key={t.dayOfWeek}>
                    <label>
                      Jour
                      <input value={t.dayLabel} readOnly />
                    </label>
                    <label>
                      Objectif
                      <input
                        value={t.title}
                        onChange={(e) => updateEditTask(t.dayOfWeek, { title: e.target.value })}
                        required
                        minLength={3}
                      />
                    </label>
                    <label>
                      Description
                      <input
                        value={t.description}
                        onChange={(e) => updateEditTask(t.dayOfWeek, { description: e.target.value })}
                      />
                    </label>
                    <label>
                      ECO
                      <input
                        value={t.rewardEco}
                        onChange={(e) => updateEditTask(t.dayOfWeek, { rewardEco: e.target.value })}
                        required
                      />
                    </label>
                  </div>
                ))}
              </div>

              <div className="edit-actions">
                <button type="submit" disabled={busy}>
                  Enregistrer
                </button>
                <button
                  className="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditId("");
                    setEditTasks([]);
                  }}
                >
                  Fermer
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="panel">
          <div className="top">
            <div>
              <h2>Soumissions de tâches</h2>
              <p>Validation admin obligatoire avant attribution ECO on-chain.</p>
            </div>
            <div className="admin-tools">
              <select
                value={submissionFilter}
                onChange={(e) => setSubmissionFilter(e.target.value)}
              >
                {["SUBMITTED", "PROCESSING", "FAILED", "COMPLETED", "REJECTED"].map((s) => (
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
          {submissions.length === 0 ? (
            <p>Aucune soumission en statut {submissionFilter}.</p>
          ) : (
            <div className="list">
              {submissions.map((s) => (
                <article className="item admin-item" key={s.id}>
                  <div>
                    <strong>
                      {s.day_label || ""} · {s.task_title}
                    </strong>
                    <small>
                      {s.full_name} · {s.email}
                    </small>
                    <small>
                      {s.challenge_title} · {s.reward_eco} ECO
                    </small>
                    {s.last_error && <small className="err-text">{s.last_error}</small>}
                  </div>
                  <div className="admin-actions">
                    <span className={`status ${statusClass(s.status)}`}>{s.status_label || s.status}</span>
                    {s.status === "SUBMITTED" && (
                      <>
                        <button type="button" disabled={busy} onClick={() => adminTaskAction(s.id, "validate")}>
                          Valider + mint
                        </button>
                        <button
                          className="ghost danger"
                          type="button"
                          disabled={busy}
                          onClick={() => adminTaskAction(s.id, "reject")}
                        >
                          Refuser
                        </button>
                      </>
                    )}
                    {s.status === "FAILED" && (
                      <button type="button" disabled={busy} onClick={() => adminTaskAction(s.id, "retry")}>
                        Retry
                      </button>
                    )}
                    {s.status === "PROCESSING" && (
                      <button type="button" disabled={busy} onClick={() => adminTaskAction(s.id, "reconcile")}>
                        Réconcilier
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {selectedChallengeId && (
          <section className="panel">
            <h2>Progression des utilisateurs</h2>
            {progressRows.length === 0 ? (
              <p>Aucun inscrit sur ce défi.</p>
            ) : (
              <div className="list">
                {progressRows.map((row) => (
                  <article className="item admin-item" key={row.enrollment_id}>
                    <div>
                      <strong>
                        {row.full_name} · {row.completed_tasks}/7
                      </strong>
                      <small>
                        {row.email} · bonus {row.bonus_reward_status}
                        {row.badge_code ? ` · badge ${row.badge_code}` : ""}
                      </small>
                    </div>
                    <div className="admin-actions">
                      {row.bonus_reward_status === "PENDING" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => adminBonusAction(row.enrollment_id, "validate-bonus")}
                        >
                          Valider bonus
                        </button>
                      )}
                      {row.bonus_reward_status === "FAILED" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => adminBonusAction(row.enrollment_id, "retry-bonus")}
                        >
                          Retry bonus
                        </button>
                      )}
                      {row.bonus_reward_status === "PROCESSING" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => adminBonusAction(row.enrollment_id, "reconcile-bonus")}
                        >
                          Réconcilier bonus
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </>
    );
  }

  const tasks = current?.tasks || [];
  const progress = current?.progress;

  return (
    <>
      <section className="panel challenge-panel">
        <div className="top">
          <div>
            <h2>Défi écologique hebdomadaire</h2>
            <p>
              {current?.challenge
                ? `${current.challenge.title} · ${String(current.challenge.week_start).slice(0, 10)} → ${String(
                    current.challenge.week_end
                  ).slice(0, 10)}`
                : current?.message || "Aucun défi actif pour le moment."}
            </p>
          </div>
          <button className="ghost" type="button" onClick={() => loadUser().catch(handleError)}>
            Actualiser
          </button>
        </div>

        {motivation && <div className="motivation-banner">{motivation}</div>}

        {progress && (
          <div className="stats challenge-stats">
            <div>
              <span className="label">Progression</span>
              <strong>
                {progress.completedCount}/{progress.totalTasks} tâches
              </strong>
              <div className="progress-track" aria-hidden>
                <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
              </div>
            </div>
            <div>
              <span className="label">Récompenses ECO (confirmées)</span>
              <strong>{progress.totalRewardsEco} ECO</strong>
              <small className="muted-block">
                Tâches {progress.earnedEco} · Bonus semaine {progress.bonusEco} ({progress.bonusStatus})
              </small>
            </div>
          </div>
        )}

        {tasks.length > 0 && (
          <div className="week-grid">
            {tasks.map((task) => (
              <article className={`day-card status-${task.status.toLowerCase()}`} key={task.progressId}>
                <header>
                  <span className="day-name">{task.dayLabel}</span>
                  <span className={`status ${statusClass(task.status)}`}>{task.statusLabel}</span>
                </header>
                <h3>{task.title}</h3>
                <p>{task.description}</p>
                <small>Récompense potentielle : {task.rewardEco} ECO</small>
                {task.lastError && <small className="err-text">{task.lastError}</small>}
                <div className="day-actions">
                  {task.status === "TODO" && (
                    <>
                      <button className="ghost" type="button" disabled={busy} onClick={() => onStart(task.progressId)}>
                        Commencer
                      </button>
                      <button type="button" disabled={busy} onClick={() => onComplete(task.progressId)}>
                        Marquer comme terminée
                      </button>
                    </>
                  )}
                  {task.status === "IN_PROGRESS" && (
                    <button type="button" disabled={busy} onClick={() => onComplete(task.progressId)}>
                      Marquer comme terminée
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Badges & trophées</h2>
        {badges.length === 0 ? (
          <p>Terminez un défi hebdomadaire validé pour gagner votre premier badge.</p>
        ) : (
          <div className="badge-row">
            {badges.map((b) => (
              <div className="badge-chip" key={b.id} title={b.badge_code}>
                <strong>{b.label}</strong>
                <small>{new Date(b.earned_at).toLocaleDateString("fr-FR")}</small>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Historique des défis</h2>
        {history.length === 0 ? (
          <p>Aucun historique pour le moment.</p>
        ) : (
          <div className="list">
            {history.map((h) => (
              <article className="item" key={h.enrollmentId}>
                <div>
                  <strong>{h.title}</strong>
                  <small>
                    {String(h.weekStart).slice(0, 10)} → {String(h.weekEnd).slice(0, 10)} · {h.completedTasks}/
                    {h.totalTasks}
                    {h.badgeCode ? ` · ${h.badgeCode}` : ""}
                  </small>
                </div>
                <span className={`status ${h.finished ? "approved" : "pending"}`}>
                  {h.finished ? "Terminé" : "En cours"}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
