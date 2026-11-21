// Child picker (wireframe c-picker): the app opens here every time, even with one child (decision 3).
// One tile per child; a tap starts the session and opens today's queue. No add, edit, delete or back.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { liveDb } from '../data/liveDb';
import { listChildren } from '../data/profiles';
import type { ChildProfile } from '../data/types';
import { ensureSession } from '../learning/session';
import { ParentLock } from '../parent/ParentLock';
import { Screen } from '../ui/components/Screen';
import { Text } from '../ui/components/Text';
import { CHILD_PICTURES } from '../ui/PicturePicker';
import { theme } from '../ui/theme';

export default function ChildPicker() {
  const [children, setChildren] = useState<ChildProfile[]>([]);

  // Reread on every return, so a child the parent added or archived shows at once.
  useFocusEffect(
    useCallback(() => {
      setChildren(listChildren(liveDb()));
    }, []),
  );

  const choose = (child: ChildProfile) => {
    ensureSession(liveDb(), child.id, new Date().toISOString());
    router.push(`/child/${child.id}`);
  };

  return (
    <Screen variant="child">
      <ParentLock />
      <View style={styles.tiles}>
        {children.map((c) => (
          <Pressable
            key={c.id}
            testID={`child-tile-${c.id}`}
            accessibilityRole="button"
            accessibilityLabel={c.nickname}
            onPress={() => choose(c)}
            style={styles.tile}
          >
            <Text mode="child" variant="wordCard">
              {CHILD_PICTURES[c.picture] ?? ''}
            </Text>
            <Text mode="child" variant="name">
              {c.nickname}
            </Text>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const { color, radius, space, touch } = theme;

const styles = StyleSheet.create({
  tiles: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignContent: 'center', gap: touch.child.gap },
  tile: {
    width: touch.child.pickerTile,
    alignItems: 'center',
    gap: space[2],
    paddingVertical: space[4],
    borderRadius: radius.child.tile,
    borderWidth: 2,
    borderColor: color.child.borderStrong,
    backgroundColor: color.child.surface,
  },
});
