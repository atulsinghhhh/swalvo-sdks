import { afterEach, describe, expect, it } from '@jest/globals';
import { dashboardUrlFor } from '../../src/commands/login.js';

describe('dashboardUrlFor', () => {
  const saved = process.env.SWALVO_DASHBOARD_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.SWALVO_DASHBOARD_URL;
    else process.env.SWALVO_DASHBOARD_URL = saved;
  });

  it('maps a local API to the local dashboard port', () => {
    delete process.env.SWALVO_DASHBOARD_URL;
    expect(dashboardUrlFor('http://localhost:4100')).toBe('http://localhost:3001');
  });

  it('maps a hosted api.<domain> to app.<domain>', () => {
    delete process.env.SWALVO_DASHBOARD_URL;
    expect(dashboardUrlFor('https://api.swalvo.com')).toBe('https://app.swalvo.com');
  });

  it('prefers SWALVO_DASHBOARD_URL when set', () => {
    process.env.SWALVO_DASHBOARD_URL = 'https://dash.example.com';
    expect(dashboardUrlFor('https://api.swalvo.com')).toBe('https://dash.example.com');
  });
});
