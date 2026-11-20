import type request from 'supertest';

export async function replaceVariables(
  api: ReturnType<typeof request.agent>,
  path: string,
  variables: object[],
  status = 200,
) {
  const current = (await api.get(path).expect(200)).body.data;
  return api.put(path).send({ expectedRevision: current.revision, variables }).expect(status);
}
