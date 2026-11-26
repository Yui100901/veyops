import { randomUUID } from 'node:crypto';
import type { Test } from 'supertest';

export async function flowTarget(
  api: { post(url: string): Test; patch(url: string): Test },
  automatic = false,
  host = '127.0.0.1',
) {
  const credential = (
    await api
      .post('/api/v1/credentials')
      .send({ name: 'Execution SSH ' + host, type: 'SSH_PASSWORD', secret: { password: randomUUID() } })
      .expect(201)
  ).body.data;
  const server = (
    await api
      .post('/api/v1/servers')
      .send({
        name: 'Execution server ' + host,
        host,
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
