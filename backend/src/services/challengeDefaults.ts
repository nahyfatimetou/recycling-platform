import { ecoAmountToWei } from "./rewardPolicy";

export type DefaultChallengeTask = {
  dayOfWeek: number;
  title: string;
  description: string;
  rewardEco: string;
};

/** Default Monday→Sunday ecological tasks (1 = Monday). */
export const DEFAULT_WEEKLY_TASKS: DefaultChallengeTask[] = [
  {
    dayOfWeek: 1,
    title: "Collecter et trier les bouteilles en plastique",
    description: "Rassemblez et triez correctement vos bouteilles plastique du jour.",
    rewardEco: "2"
  },
  {
    dayOfWeek: 2,
    title: "Recycler du papier",
    description: "Déposez du papier usagé dans le bac de recyclage adapté.",
    rewardEco: "2"
  },
  {
    dayOfWeek: 3,
    title: "Utiliser une bouteille réutilisable",
    description: "Remplacez une bouteille jetable par une gourde réutilisable.",
    rewardEco: "2"
  },
  {
    dayOfWeek: 4,
    title: "Recycler les emballages en carton",
    description: "Aplatissez et recyclez vos cartons / emballages du jour.",
    rewardEco: "2"
  },
  {
    dayOfWeek: 5,
    title: "Éviter les sacs en plastique",
    description: "Utilisez un sac réutilisable pour vos courses ou déplacements.",
    rewardEco: "2"
  },
  {
    dayOfWeek: 6,
    title: "Participer à une action de nettoyage",
    description: "Ramassez des déchets dans un espace public ou partagé.",
    rewardEco: "2"
  },
  {
    dayOfWeek: 7,
    title: "Faire le bilan de ses déchets recyclés",
    description: "Notez ce que vous avez recyclé cette semaine et ce qui reste à améliorer.",
    rewardEco: "2"
  }
];

export const DEFAULT_BONUS_ECO = "10";

export const DAY_LABELS_FR: Record<number, string> = {
  1: "Lundi",
  2: "Mardi",
  3: "Mercredi",
  4: "Jeudi",
  5: "Vendredi",
  6: "Samedi",
  7: "Dimanche"
};

export function defaultTaskRewardWei(rewardEco = "2"): string {
  return ecoAmountToWei(rewardEco).toString();
}

export function defaultBonusRewardWei(bonusEco = DEFAULT_BONUS_ECO): string {
  return ecoAmountToWei(bonusEco).toString();
}

/** ISO date (YYYY-MM-DD) of the Monday of the week containing `date`. */
export function mondayOf(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay(); // 0 Sun … 6 Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

export function sundayFromMonday(mondayIso: string): string {
  const d = new Date(`${mondayIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}
