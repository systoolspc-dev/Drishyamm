// Vertical-aware data selector for the Activity Monitoring module.
//
// Retail and corporate render the SAME components; this hook hands each
// component the dataset for the active use-case (retail = shop floor, corporate
// = office). Shapes are identical (see corporate-data.js), so consumers just
// destructure what they need. Any non-corporate vertical falls back to retail.
import { useActivityParams } from './useCaseStore';
import * as retail from './dashboard/data';
import * as retailPages from './pages-data';
import { demoEvents as retailEvents } from './pages-data';
import * as corp from './corporate-data';

export function useModuleData() {
  const { useCase } = useActivityParams();

  if (useCase === 'corporate') {
    return {
      STORES: corp.STORES, NOW_IST: corp.NOW_IST, TODAY: corp.TODAY, KPIS: corp.KPIS,
      EMPLOYEES: corp.EMPLOYEES, ATTENTION: corp.ATTENTION, TRENDS: corp.TRENDS,
      FEED: corp.FEED, STATUS_META: corp.STATUS_META,
      BREAKS: corp.BREAKS, PHONE_EVENTS: corp.PHONE_EVENTS, PHONE_WEEKLY: corp.PHONE_WEEKLY, PHONE_TREND: corp.PHONE_TREND,
      DAY_TIMELINES: corp.DAY_TIMELINES, PROFILE_STATS: corp.PROFILE_STATS,
      WEEKLY_REPORT: corp.WEEKLY_REPORT, REPORT_META: corp.REPORT_META, events: corp.demoEvents,
    };
  }

  return {
    STORES: retail.STORES, NOW_IST: retail.NOW_IST, TODAY: retail.TODAY, KPIS: retail.KPIS,
    EMPLOYEES: retail.EMPLOYEES, ATTENTION: retail.ATTENTION, TRENDS: retail.TRENDS,
    FEED: retail.FEED, STATUS_META: retail.STATUS_META,
    BREAKS: retailPages.BREAKS, PHONE_EVENTS: retailPages.PHONE_EVENTS, PHONE_WEEKLY: retailPages.PHONE_WEEKLY, PHONE_TREND: retailPages.PHONE_TREND,
    DAY_TIMELINES: retailPages.DAY_TIMELINES, PROFILE_STATS: retailPages.PROFILE_STATS,
    WEEKLY_REPORT: retailPages.WEEKLY_REPORT, REPORT_META: retailPages.REPORT_META, events: retailEvents,
  };
}
