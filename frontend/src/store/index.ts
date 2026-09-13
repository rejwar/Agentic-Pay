import { configureStore } from "@reduxjs/toolkit"
import agentReducer from "./slices/agentSlice"
import pythReducer from "./slices/pythSlice"

export const store = configureStore({
  reducer: {
    agent: agentReducer,
    pyth: pythReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false, // Prevents errors with non-serializable objects if any
    }),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch

// Re-export all slice actions, selectors, and typed hooks
export * from "./slices/agentSlice"
export * from "./slices/pythSlice"
export { useAppDispatch, useAppSelector } from "./hooks"
