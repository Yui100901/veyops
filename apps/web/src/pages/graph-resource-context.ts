import { createContext } from 'react';
import type { User } from '../models';

export const GraphResourceContext = createContext<
  | {
      role: User['role'];
      reload: () => void | Promise<void>;
    }
  | undefined
>(undefined);
