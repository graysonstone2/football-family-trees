// Kept apart from functions/schedule.ts so App.tsx can read the URL parameter
// without pulling the 2026 schedule JSON into the main chunk.
export type ScheduleView = 'week' | 'ranked' | 'trees';

export const SCHEDULE_VIEWS: ScheduleView[] = ['ranked', 'week', 'trees'];
