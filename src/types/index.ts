/**
 * Domain types for Capago appointment slot scraping and monitoring.
 */

export type SlotStatus = 'available' | 'disabled' | 'booked' | 'unknown';

export interface AppointmentSlot {
  date: string; // ISO format: YYYY-MM-DD
  time?: string; // HH:mm format if time slots are parsed
  period?: 'Morning' | 'Afternoon' | string;
  slotType?: 'classic' | 'prime' | string;
  isAvailable: boolean;
  status: SlotStatus;
  rawText?: string;
  metadata?: Record<string, string>;
}

export interface CalendarDayInfo {
  date: string;
  dayNumber: number;
  month: number;
  year: number;
  isAvailable: boolean;
  elementSelector?: string;
  slots: AppointmentSlot[];
}

export type NavigationStep =
  | 'LOGIN'
  | 'DASHBOARD'
  | 'PREREQUISITES'
  | 'SUBMISSION_LOCATION'
  | 'APPLICANT_COUNT'
  | 'APPLICANT_DETAILS'
  | 'TRAVEL_PROJECT'
  | 'TRAVEL_PROJECT_REVIEW'
  | 'SERVICE_OVERVIEW'
  | 'SERVICE_ALL_INCLUSIVE'
  | 'SERVICE_INSURANCE'
  | 'SERVICE_OPTIONS'
  | 'CALENDAR_ROUTE';

export interface StepNavigationResult {
  step: NavigationStep;
  success: boolean;
  url: string;
  durationMs: number;
  error?: string;
}

export interface ScrapeRunReport {
  timestamp: string;
  center: string;
  category: string;
  totalDaysScanned: number;
  availableDays: CalendarDayInfo[];
  availableSlots: AppointmentSlot[];
  hasAvailableSlots: boolean;
}

export interface TelegramAlertPayload {
  report: ScrapeRunReport;
  portalUrl: string;
}

export interface ApplicantProfile {
  title: 'Mr' | 'Mrs' | 'Miss' | string;
  firstName: string;
  lastName: string;
  passportNumber: string;
  dob: string; // dd/mm/yyyy
  phone: string;
  email?: string;
  departureDate: string; // dd/mm/yyyy
  category?: string;
  center?: string;
  purpose?: string;
  visaVariation?: string;
  situation?: string;
  needsFranceVisasAssistance?: boolean; // If true, selects Option 2 (24 AZN assistance) with 0 risk of fake FRA rejection
  franceVisasRef?: string; // Official FRA reference number (e.g. FRA1234567890123) if Option 1 is chosen
  monthsToScan?: number; // Number of months forward to monitor (1 to 6)
}

export interface UserBotSession {
  chatId: number;
  username?: string;
  step?: string;
  profileDraft?: Partial<ApplicantProfile>;
  savedProfile?: ApplicantProfile;
  monitoringActive: boolean;
  lastCheckedAt?: string;
}
