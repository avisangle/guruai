// /parent/child/<id> edits a child's profile; /parent/child/new adds one (wireframes pm-profile*).
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { liveDb } from '../../../data/liveDb';
import { listChildren } from '../../../data/profiles';
import { ProfileForm } from '../../../parent/ProfileForm';
import { Screen } from '../../../ui/components/Screen';

export default function ChildProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [{ child, taken }] = useState(() => {
    const children = listChildren(liveDb());
    const others = children.filter((c) => c.id !== id);
    return { child: children.find((c) => c.id === id) ?? null, taken: others.map((c) => c.picture) };
  });

  const done = () => (router.canGoBack() ? router.back() : router.replace('/parent/settings'));

  return (
    <Screen variant="parent">
      <ProfileForm child={child} taken={taken} onSaved={done} />
    </Screen>
  );
}
