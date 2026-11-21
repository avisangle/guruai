import { Redirect } from 'expo-router';

import { IS_TEST_BUILD } from '../config/build';
import { ProbeScreen } from '../screens/ProbeScreen';

export default function ProbeRoute() {
  return IS_TEST_BUILD ? <ProbeScreen /> : <Redirect href="/" />;
}
