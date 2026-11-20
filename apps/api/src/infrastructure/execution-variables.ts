import {
  type CredentialsService,
  variableCredentialValue,
} from '../modules/credentials/credentials.service';

export const executionVariableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ExecutionVariables {
  variables: Record<string, string>;
  secretVariables: Record<string, string>;
}

export const credentialSecrets = (secret: Record<string, string>) =>
  Object.entries(secret)
    .filter(([key]) => key !== 'username')
    .map(([, value]) => value);

export async function resolveVariableCredential(
  credentials: CredentialsService,
  name: string,
  id: string,
  secrets: string[],
) {
  const credential = await credentials.decrypt(id);
  const value = variableCredentialValue(credential);
  if (value === undefined || value.includes('\0'))
    throw new Error(`敏感变量 ${name} 的凭据不含支持的值`);
  secrets.push(...credentialSecrets(credential));
  return value;
}

export async function resolveExecutionVariables(
  credentials: CredentialsService,
  { variables, secretVariables }: ExecutionVariables,
) {
  const values: Record<string, string> = Object.assign(Object.create(null), variables);
  if (
    [...Object.keys(values), ...Object.keys(secretVariables)].some(
      (key) => !executionVariableName.test(key),
    )
  )
    throw new Error('无效环境变量名');
  const secrets: string[] = [];
  for (const [name, id] of Object.entries(secretVariables)) {
    values[name] = await resolveVariableCredential(credentials, name, id, secrets);
  }
  return { values, secrets };
}
