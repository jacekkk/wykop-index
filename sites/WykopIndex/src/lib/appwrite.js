import { Client, TablesDB, Storage } from "appwrite";

const client = new Client()
    .setEndpoint(import.meta.env.VITE_APPWRITE_ENDPOINT)
    .setProject(import.meta.env.VITE_APPWRITE_PROJECT_ID);

const tablesDB = new TablesDB(client);
const storage = new Storage(client);

export { client, tablesDB, storage };
