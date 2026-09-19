/** Types shared by the browser UI and the server. No secrets or server imports. */
export interface User {
  id: string;
  email: string;
  name: string;
  age: number | null;
  onboarded: boolean;
}

export interface Ingredient {
  id?: string;
  name: string;
  /** Amount in the user's DAILY serving, independent of the number of reminders. */
  amount: number;
  unit: string;
}

export interface IntakeSchedule {
  id: string;
  time: string;
  startDate?: string;
  endDate?: string | null;
}

export interface Supplement {
  id: string;
  name: string;
  brand: string;
  color: string;
  createdAt?: string;
  ingredients: Ingredient[];
  schedules: IntakeSchedule[];
  times?: string[];
  scheduleChangeEffectiveDate?: string;
}

export interface TodayItem {
  scheduleId: string;
  supplementId: string;
  name: string;
  brand: string;
  color: string;
  time: string;
  completedAt: string | null;
  archived?: boolean;
}

export interface Dashboard {
  date: string;
  name: string;
  age: number | null;
  items: TodayItem[];
  completed: number;
  total: number;
  streak: number;
}

export interface DayHistory {
  date: string;
  total: number;
  completed: number;
  rate: number;
  items: TodayItem[];
}

export interface Settings {
  name: string;
  age: number | null;
  email: string;
  reminderEnabled: boolean;
  delayMinutes: number;
  guardianDelayMinutes: number;
  guardianEmail: string;
  guardianEnabled: boolean;
  guardianConsentedAt: string | null;
  timezone: string;
  emailMode: string;
}

export interface UnitAmount {
  amount: number;
  unit: string;
}

export interface DuplicateGroup {
  key: string;
  name: string;
  count: number;
  products: {
    id: string;
    name: string;
    color: string;
    amounts: UnitAmount[];
  }[];
  totals: UnitAmount[];
  incompatibleUnits: boolean;
}

export interface SurveyResult {
  name: string;
  reason: string;
  food: string;
  sourceUrl: string;
}
