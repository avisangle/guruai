import type { ReactNode } from 'react';

import { IS_TEST_BUILD } from './build';

// Renders its children only in test builds.
export function TestOnly({ children }: { children: ReactNode }) {
  return IS_TEST_BUILD ? <>{children}</> : null;
}
