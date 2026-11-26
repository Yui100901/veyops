import { randomUUID } from 'node:crypto';
import type { SuperTest, Test } from 'supertest';

export async function flowTarget(api: Pick<SuperTest<Test>, 'post' | 'patch'>, automatic = false) {
  const credential = (
    await api
      .post('/api/v1/credentials')
      .send({ name: 'Execution SSH', type: 'SSH_PASSWORD', secret: { password: randomUUID() } })
      .expect(201)
  ).body.data;
  const server = (
    await api
      .post('/api/v1/servers')
      .send({
        name: 'Execution server',
        host: '127.0.0.1',
        username: 'fixture',
        credentialId: credential.id,
        hostKeyFingerprint: 'a'.repeat(64),
      })
      .expect(201)
  ).body.data;
  if (automatic)
    await api
      .patch('/api/v1/servers/' + server.id + '/automatic-execution')
      .send({ enabled: true })
      .expect(200);
  return server.id as string;
}
