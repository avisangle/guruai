// /parent/child/<id> edits a child's profile; /parent/child/new adds one (wireframes pm-profile*).
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { liveDb } from '../../../data/liveDb';
import { getChild, listChildren } from '../../../data/profiles';
import { ProfileForm } from '../../../parent/ProfileForm';
import { Screen } from '../../../ui/components/Screen';

export default function ChildProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [{ child, taken }] = useState(() => {
    const db = liveDb();
    const found = id === 'new' ? null : getChild(db, id);
    return { child: found, taken: listChildren(db).filter((c) => c.id !== found?.id).map((c) => c.picture) };
  });

  const done = () => (router.canGoBack() ? router.back() : router.replace('/parent/settings'));

  return (
    <Screen variant="parent">
      <ProfileForm child={child} taken={taken} onSaved={done} />
    </Screen>
  );
}
