// Lets the onboarding tell the root layout that the first child exists, so its route
// guards flip from onboarding to the child picker.
import { createContext, useContext } from 'react';

type FirstRun = { childAdded: () => void };

export const FirstRunContext = createContext<FirstRun>({ childAdded: () => undefined });

export const useFirstRun = () => useContext(FirstRunContext);
