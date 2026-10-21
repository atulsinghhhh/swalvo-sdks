import { describe, expect, it, jest } from '@jest/globals';
import type { SwalvoApiClient } from '../../src/lib/api-client.js';
import { lookupProject } from '../../src/lib/project-lookup.js';
import type { Project } from '../../src/lib/types.js';

const ID_A = '16281d1e-0000-4000-8000-000000000001';
const ID_B = '16281d1e-0000-4000-8000-000000000002';

function fakeClient(projects: Array<Pick<Project, 'id' | 'name'>>) {
  return {
    getProject: jest.fn(async (id: string) => projects.find((p) => p.id === id) as Project),
    listProjects: jest.fn(async () => projects as Project[]),
  } as unknown as SwalvoApiClient & { getProject: jest.Mock; listProjects: jest.Mock };
}

describe('lookupProject', () => {
  it('fetches an ID directly without listing', async () => {
    const client = fakeClient([{ id: ID_A, name: 'my-video-app' }]);
    await expect(lookupProject(client, ID_A)).resolves.toMatchObject({ id: ID_A });
    expect(client.listProjects).not.toHaveBeenCalled();
  });

  it('resolves an exact project name', async () => {
    const client = fakeClient([
      { id: ID_A, name: 'my-video-app' },
      { id: ID_B, name: 'other' },
    ]);
    await expect(lookupProject(client, 'my-video-app')).resolves.toMatchObject({ id: ID_A });
  });

  it('falls back to an ID lookup when no project has that name', async () => {
    const client = fakeClient([{ id: 'proj-1', name: 'my-video-app' }]);
    await expect(lookupProject(client, 'proj-1')).resolves.toMatchObject({ id: 'proj-1' });
    expect(client.getProject).toHaveBeenCalledWith('proj-1');
  });

  it('refuses to guess between two projects with the same name', async () => {
    const client = fakeClient([
      { id: ID_A, name: 'dup' },
      { id: ID_B, name: 'dup' },
    ]);
    await expect(lookupProject(client, 'dup')).rejects.toThrow(/2 projects are named "dup"/);
  });
});
