import { Redirect } from 'expo-router';

import { IS_TEST_BUILD } from '../config/build';
import { LessonScreen } from '../screens/LessonScreen';

// Tester tools: lesson menu, recording panel, clip export, demo link. Linked from the child picker.
export default function TesterRoute() {
  return IS_TEST_BUILD ? <LessonScreen /> : <Redirect href="/" />;
}
