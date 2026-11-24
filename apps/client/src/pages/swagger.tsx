import { useTranslation } from "react-i18next";

import { OpenAPI } from "@/components/openapi";

export function SwaggerPage() {
  const { t } = useTranslation();

  const source = import.meta.env.API_BASE_URL.endsWith("/")
    ? import.meta.env.API_BASE_URL + "openapi.json"
    : import.meta.env.API_BASE_URL + "/openapi.json";

  const dataServers = [
    (import.meta.env.API_BASE_URL as string),
  ];

  const description = t("api-server");

  return (
    <>
      <section className="flex flex-col items-center justify-center gap-4 py-8 md:py-10">
        <OpenAPI
          dataServers={dataServers}
          description={description}
          source={source}
        />
      </section>
    </>
  );
}
