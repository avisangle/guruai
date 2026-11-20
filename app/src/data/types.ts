// Row types for the data layer. Booleans are stored as 0/1, lists as JSON text;
// the repos convert both ways.

export type Ids = {
  uuid?: () => string;
  childCode?: () => string;
};

// The app's two languages; the role names below are aliases of it.
export type AppLang = 'mr' | 'en';
export type ParentLang = AppLang;
export type JudgeCheck = 'ok' | 'slow' | 'oom';

export type Device = {
  id: string;
  device_id: string;
  parent_lang: ParentLang;
  allow_mobile_data: boolean;
  consent_clips: boolean | null; // null: not asked yet
  consent_summaries: boolean | null;
  consent_answered_at: string | null;
  judge_check: JudgeCheck | null;
  judge_p90_ms: number | null;
  mic_last_granted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Medium = AppLang;
export type StyleLevel = 'mr_led' | 'en_led';

export type ChildProfile = {
  id: string;
  nickname: string;
  picture: string;
  class: string;
  board: string;
  medium: Medium;
  goals: string[];
  style_level: StyleLevel;
  style_locked: boolean;
  lessons_per_day: number; // 1-5
  active_cap_min: number | null; // null: no cap
  tutor: string;
  child_code: string;
  setup_done: string[]; // reviewed setup sections
  archived: boolean;
  created_at: string;
  updated_at: string;
};

export type NewChild = Pick<ChildProfile, 'nickname' | 'picture' | 'class' | 'medium'>;

export type ChildUpdate = Partial<Omit<ChildProfile, 'id' | 'child_code' | 'created_at' | 'updated_at'>>;
