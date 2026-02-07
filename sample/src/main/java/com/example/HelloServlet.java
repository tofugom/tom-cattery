package com.example;

import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.LocalDateTime;

@WebServlet("/hello")
public class HelloServlet extends HttpServlet {

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("text/html; charset=UTF-8");
        resp.getWriter().println("<h1>Hello from Tom Cattery!</h1>");
        resp.getWriter().println("<p>Server Time: " + LocalDateTime.now() + "</p>");
        resp.getWriter().println("<p><a href=\"/\">Back to Home</a></p>");
    }
}
