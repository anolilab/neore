// The phone-push background task must exist before the app starts: a push can launch the app headless (Android).
import "./src/notifications/background-task";
import "expo-router/entry";
