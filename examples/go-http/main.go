package main

import (
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	server := http.Server{
		Addr:              "127.0.0.1:" + port,
		ReadHeaderTimeout: 3 * time.Second,
		WriteTimeout:      3 * time.Second,
		Handler:           http.HandlerFunc(health),
	}
	log.Fatal(server.ListenAndServe())
}

func health(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/healthz" {
		http.NotFound(response, request)
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		http.Error(response, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(response, "{\"status\":\"ok\",\"language\":\"go\"}\n")
}
